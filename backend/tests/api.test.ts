import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { PDFDocument } from 'pdf-lib';

const testDirectory = mkdtempSync(join(tmpdir(), 'case-study-tool-'));
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = join(testDirectory, 'test.sqlite');
process.env.REPORT_STORAGE_DIR = join(testDirectory, 'reports');
process.env.UPLOAD_STORAGE_DIR = join(testDirectory, 'uploads');
process.env.SESSION_SECRET = 'integration-test-session-secret-value';
process.env.GROQ_API_KEY = '';
process.env.TAVILY_API_KEY = '';

let server: Server;
let baseUrl: string;
let database: typeof import('../src/storage/database').database;
let parseGitHubUrl: typeof import('../src/services/github-analyzer.service').parseGitHubUrl;
let assertPublicUrl: typeof import('../src/services/network-safety.service').assertPublicUrl;
let parseRobotsTxt: typeof import('../src/services/website-crawler.service').parseRobotsTxt;
let isAllowedByRobots: typeof import('../src/services/website-crawler.service').isAllowedByRobots;
let synthesizeCaseStudy: typeof import('../src/services/case-study.service').synthesizeCaseStudy;
let classifyProjectType: typeof import('../src/services/case-study.service').classifyProjectType;
let validateModelProjectClassification: typeof import('../src/services/case-study.service').validateModelProjectClassification;
let validateModelSuggestedFields: typeof import('../src/services/case-study.service').validateModelSuggestedFields;
let researchCompetitors: typeof import('../src/services/competitor-research.service').researchCompetitors;
let refreshProjectFields: typeof import('../src/services/project-fields.service').refreshProjectFields;
let rebuildProjectKnowledgeIndex: typeof import('../src/services/project-knowledge.service').rebuildProjectKnowledgeIndex;
let retrieveProjectKnowledge: typeof import('../src/services/project-knowledge.service').retrieveProjectKnowledge;

before(async () => {
  const [{ createApp }, storage, github, networkSafety, crawler, caseStudyService, competitorService, fieldsService, knowledgeService] = await Promise.all([
    import('../src/app'),
    import('../src/storage/database'),
    import('../src/services/github-analyzer.service'),
    import('../src/services/network-safety.service'),
    import('../src/services/website-crawler.service'),
    import('../src/services/case-study.service'),
    import('../src/services/competitor-research.service'),
    import('../src/services/project-fields.service'),
    import('../src/services/project-knowledge.service'),
  ]);
  database = storage.database;
  parseGitHubUrl = github.parseGitHubUrl;
  assertPublicUrl = networkSafety.assertPublicUrl;
  parseRobotsTxt = crawler.parseRobotsTxt;
  isAllowedByRobots = crawler.isAllowedByRobots;
  synthesizeCaseStudy = caseStudyService.synthesizeCaseStudy;
  classifyProjectType = caseStudyService.classifyProjectType;
  validateModelProjectClassification = caseStudyService.validateModelProjectClassification;
  validateModelSuggestedFields = caseStudyService.validateModelSuggestedFields;
  researchCompetitors = competitorService.researchCompetitors;
  refreshProjectFields = fieldsService.refreshProjectFields;
  rebuildProjectKnowledgeIndex = knowledgeService.rebuildProjectKnowledgeIndex;
  retrieveProjectKnowledge = knowledgeService.retrieveProjectKnowledge;
  server = createServer(createApp());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No test server address'));
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  database.close();
  rmSync(testDirectory, { recursive: true, force: true });
});

interface RequestOptions {
  method?: string;
  cookie?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const headers = new Headers({ Accept: 'application/json', ...options.headers });
  if (options.cookie) headers.set('Cookie', options.cookie);
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  return fetch(`${baseUrl}/api/v1${path}`, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

async function json(response: Response): Promise<any> {
  return response.json();
}

function sessionCookie(response: Response): string {
  const value = response.headers.getSetCookie().find((cookie) => cookie.startsWith('cst_session='));
  assert.ok(value, 'response should set a session cookie');
  return value.split(';', 1)[0];
}

test('health, private guest workspaces, authenticated project isolation, reports, and input safety', async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal((await json(health)).data.checks.find((check: { name: string }) => check.name === 'database').status, 'up');

  const firstGuest = await request('/auth/guest', { method: 'POST' });
  assert.equal(firstGuest.status, 201);
  const firstGuestCookie = sessionCookie(firstGuest);
  const firstGuestUser = (await json(firstGuest)).data as { id: string; name: string };
  assert.equal(firstGuestUser.name, 'Guest');
  const restoredGuest = await request('/auth/guest', { method: 'POST', cookie: firstGuestCookie });
  assert.equal(restoredGuest.status, 200);
  assert.equal((await json(restoredGuest)).data.id, firstGuestUser.id);
  const guestProjectResponse = await request('/projects/', {
    method: 'POST',
    cookie: firstGuestCookie,
    body: { name: 'Guest private project', websiteUrl: 'https://example.com' },
  });
  assert.equal(guestProjectResponse.status, 201);
  const secondGuest = await request('/auth/guest', { method: 'POST' });
  assert.equal(secondGuest.status, 201);
  const secondGuestProjects = await request('/projects/', { cookie: sessionCookie(secondGuest) });
  assert.deepEqual((await json(secondGuestProjects)).data.projects, []);

  const unauthenticated = await request('/projects/');
  assert.equal(unauthenticated.status, 401);
  assert.equal((await json(unauthenticated)).error.code, 'UNAUTHORIZED');

  const ownerEmail = `owner-${Date.now()}@example.test`;
  const ownerRegistration = await request('/auth/register', {
    method: 'POST',
    body: { name: 'Owner User', email: ownerEmail, password: 'Correct-Horse-12!' },
  });
  assert.equal(ownerRegistration.status, 201);
  const ownerCookie = sessionCookie(ownerRegistration);

  const session = await request('/auth/me', { cookie: ownerCookie });
  assert.equal(session.status, 200);
  assert.equal((await json(session)).data.email, ownerEmail);

  const created = await request('/projects/', {
    method: 'POST',
    cookie: ownerCookie,
    headers: { Origin: 'http://localhost:5173' },
    body: { name: 'Private project', websiteUrl: 'https://example.com' },
  });
  assert.equal(created.status, 201);
  const project = (await json(created)).data as { id: string };

  const initialProjectFields = await request(`/projects/${project.id}/fields`, { cookie: ownerCookie });
  assert.ok((await json(initialProjectFields)).data.fields.some((field: { key: string }) => field.key === 'project_name'));
  const fieldAnalysis = {
    synthesisStatus: 'fallback_no_provider',
    businessModel: 'Possible subscription model; validate with the project owner.',
    targetAudience: 'Software teams that need internal analytics.',
    suggestedFields: [{ fieldName: 'Average Contract Value', fieldType: 'currency', category: 'financial', description: 'Record a verified contract value, currency, and measurement period.' }],
    swotAnalysis: { strengths: ['Clear product focus'], weaknesses: ['Customer demand is unverified'], opportunities: ['Interview target teams'], threats: ['Competition is unverified'] },
    evidence: {
      website: { pages: [{ title: 'Acme Analytics', description: 'Analytics for small software teams', metadata: { siteName: 'Acme', keywords: ['analytics', 'software'] }, headings: ['Usage Reports', 'Team Dashboard'] }] },
      github: { metadata: { description: 'Analytics platform', sizeKb: 240 }, languages: { TypeScript: 1400, SQL: 400 }, detectedTechnology: ['React', 'Express API framework', 'Prisma ORM/database client'], dependencies: ['react', 'express', 'prisma', 'vitest', 'passport', '@aws-sdk/client-s3', 'stripe'], structure: ['package.json', 'vite.config.ts', '.github/workflows/ci.yml'], sourceInspection: { apiRoutes: ['/api/reports'], databaseIndicators: ['Prisma schema'] } },
      competitors: { status: 'not_configured' },
    },
  };
  const analyzedFields = {
    ...fieldAnalysis,
    projectClassification: classifyProjectType({ project: { name: 'Private project', websiteUrl: 'https://example.com', githubUrl: 'https://github.com/acme/analytics' }, website: fieldAnalysis.evidence.website, github: fieldAnalysis.evidence.github }),
  };
  refreshProjectFields({ id: project.id, name: 'Private project', websiteUrl: 'https://example.com', githubUrl: 'https://github.com/acme/analytics' }, analyzedFields);
  database.prepare(`
    INSERT INTO project_source_analyses (project_id, status, evidence_json, field_analysis_json, warnings_json, updated_at)
    VALUES (?, 'completed', ?, ?, '[]', ?)
  `).run(project.id, JSON.stringify(analyzedFields.evidence), JSON.stringify(analyzedFields), new Date().toISOString());
  const indexedKnowledge = await rebuildProjectKnowledgeIndex(project.id);
  assert.ok(indexedKnowledge.chunkCount > 0, 'project source and fields should be chunked into its isolated index');
  assert.equal(indexedKnowledge.embeddingModel, 'local-hash-v1', 'the local vector fallback should work without an embedding credential');
  const retrievedKnowledge = await retrieveProjectKnowledge(project.id, 'analytics for small software teams');
  assert.ok(retrievedKnowledge.some((chunk) => chunk.sourceType === 'website' && /Analytics for small software teams/.test(chunk.content)));
  const firstFieldSet = (await json(await request(`/projects/${project.id}/fields`, { cookie: ownerCookie }))).data.fields as Array<Record<string, any>>;
  const companyField = firstFieldSet.find((field) => field.key === 'company_name');
  assert.ok(companyField);
  assert.equal(companyField?.value, 'Acme');
  assert.ok(firstFieldSet.some((field) => field.key === 'programming_languages'));
  const typeField = firstFieldSet.find((field) => field.key === 'project_type');
  assert.ok(typeField);
  assert.equal(typeField?.value, 'Full Stack');
  assert.deepEqual(typeField?.options, ['Frontend', 'Full Stack', 'Backend', 'Automation', 'Not enough evidence']);
  assert.equal(typeField?.source, 'GitHub');
  assert.ok(firstFieldSet.some((field) => field.key === 'testing_frameworks'));
  assert.ok(firstFieldSet.some((field) => field.key === 'authentication_indicators'));
  assert.ok(firstFieldSet.some((field) => field.key === 'cloud_provider_indicators'));
  assert.ok(firstFieldSet.some((field) => field.key === 'external_api_sdk_dependencies'));
  assert.ok(firstFieldSet.some((field) => field.key === 'suggested_software_architecture_pattern' && field.category === 'technical'));
  const overriddenProjectType = await request(`/projects/${project.id}/fields/${typeField.id}`, { method: 'PATCH', cookie: ownerCookie, body: { value: 'Frontend' } });
  assert.equal((await json(overriddenProjectType)).data.field.source, 'User');
  const analysisSuggestion = firstFieldSet.find((field) => field.key === 'suggested_ai_average_contract_value');
  assert.equal(analysisSuggestion?.source, 'AI');
  assert.equal(analysisSuggestion?.value, null);
  assert.equal(analysisSuggestion?.suggestionStatus, 'pending');
  const overriddenCompany = await request(`/projects/${project.id}/fields/${companyField.id}`, { method: 'PATCH', cookie: ownerCookie, body: { value: 'Owner corrected company' } });
  assert.equal((await json(overriddenCompany)).data.field.source, 'User');
  const trafficSuggestion = firstFieldSet.find((field) => field.key === 'suggested_estimated_traffic');
  assert.ok(trafficSuggestion);
  const rejectedSuggestion = await request(`/projects/${project.id}/fields/${trafficSuggestion.id}/suggestion`, { method: 'POST', cookie: ownerCookie, body: { action: 'reject' } });
  assert.equal((await json(rejectedSuggestion)).data.field.suggestionStatus, 'rejected');
  const fundingSuggestion = firstFieldSet.find((field) => field.key === 'suggested_funding_stage');
  assert.ok(fundingSuggestion);
  const acceptedSuggestion = await request(`/projects/${project.id}/fields/${fundingSuggestion.id}/suggestion`, { method: 'POST', cookie: ownerCookie, body: { action: 'accept' } });
  assert.equal((await json(acceptedSuggestion)).data.field.suggestionStatus, 'accepted');

  const updatedEvidence = structuredClone(analyzedFields);
  updatedEvidence.evidence.website.pages[0]!.metadata.siteName = 'Acme Labs';
  updatedEvidence.projectClassificationSource = 'Groq';
  refreshProjectFields({ id: project.id, name: 'Private project', websiteUrl: 'https://example.com', githubUrl: 'https://github.com/acme/analytics' }, updatedEvidence);
  const refreshedFields = (await json(await request(`/projects/${project.id}/fields`, { cookie: ownerCookie }))).data.fields as Array<Record<string, any>>;
  const refreshedCompany = refreshedFields.find((field) => field.key === 'company_name');
  assert.equal(refreshedCompany?.value, 'Owner corrected company');
  assert.equal(refreshedCompany?.aiValue, 'Acme Labs');
  const refreshedProjectType = refreshedFields.find((field) => field.key === 'project_type');
  assert.equal(refreshedProjectType?.value, 'Frontend');
  assert.equal(refreshedProjectType?.aiValue, 'Full Stack');
  assert.equal(refreshedProjectType?.aiSource, 'AI');
  assert.equal(refreshedProjectType?.generatedBy, 'Groq project classification');
  assert.equal(refreshedFields.find((field) => field.key === 'suggested_estimated_traffic')?.suggestionStatus, 'rejected');
  assert.equal(refreshedFields.find((field) => field.key === 'suggested_funding_stage')?.suggestionStatus, 'accepted');
  assert.equal(refreshedFields.find((field) => field.key === 'suggested_ai_average_contract_value')?.suggestionStatus, 'pending');
  const restoredCompany = await request(`/projects/${project.id}/fields/${companyField.id}/restore-ai`, { method: 'POST', cookie: ownerCookie });
  assert.equal((await json(restoredCompany)).data.field.value, 'Acme Labs');
  const restoredProjectType = await request(`/projects/${project.id}/fields/${typeField.id}/restore-ai`, { method: 'POST', cookie: ownerCookie });
  assert.equal((await json(restoredProjectType)).data.field.value, 'Full Stack');

  const customFieldResponse = await request(`/projects/${project.id}/fields`, {
    method: 'POST', cookie: ownerCookie,
    body: { fieldName: 'Monthly Revenue', fieldType: 'currency', value: 1250, defaultValue: 1000, required: true, category: 'financial', description: 'Owner supplied estimate', manualNotes: 'Review monthly', options: [] },
  });
  assert.equal(customFieldResponse.status, 201);
  const customFieldId = (await json(customFieldResponse)).data.field.id as string;
  const requiredFieldResponse = await request(`/projects/${project.id}/fields`, {
    method: 'POST', cookie: ownerCookie,
    body: { fieldName: 'Owner Notes', fieldType: 'long_text', required: true },
  });
  assert.equal(requiredFieldResponse.status, 201);
  const requiredFieldId = (await json(requiredFieldResponse)).data.field.id as string;
  assert.equal((await request(`/projects/${project.id}/fields/${requiredFieldId}`, { method: 'PATCH', cookie: ownerCookie, body: { manualNotes: 'Still needs a value' } })).status, 200);
  assert.equal((await request(`/projects/${project.id}/fields/${requiredFieldId}`, { method: 'PATCH', cookie: ownerCookie, body: { value: null } })).status, 400);
  assert.equal((await request(`/projects/${project.id}/fields/${requiredFieldId}`, { method: 'PATCH', cookie: ownerCookie, body: { value: 'Ready' } })).status, 200);
  const lockedFieldResponse = await request(`/projects/${project.id}/fields`, {
    method: 'POST', cookie: ownerCookie,
    body: { fieldName: 'Locked Value', fieldType: 'text', value: 'Owner approved', readOnly: true },
  });
  const lockedFieldId = (await json(lockedFieldResponse)).data.field.id as string;
  assert.equal((await request(`/projects/${project.id}/fields/${lockedFieldId}`, { method: 'PATCH', cookie: ownerCookie, body: { value: 'Changed' } })).status, 403);
  assert.equal((await request(`/projects/${project.id}/fields/${lockedFieldId}`, { method: 'PATCH', cookie: ownerCookie, body: { readOnly: false, editable: true } })).status, 200);
  const customTextResponse = await request(`/projects/${project.id}/fields`, {
    method: 'POST', cookie: ownerCookie,
    body: { fieldName: 'Region', fieldType: 'text', value: 'North America', category: 'custom_fields' },
  });
  const customTextId = (await json(customTextResponse)).data.field.id as string;
  const fileFieldResponse = await request(`/projects/${project.id}/fields`, {
    method: 'POST', cookie: ownerCookie,
    body: { fieldName: 'Design Attachment', fieldType: 'file_attachment', category: 'custom_fields' },
  });
  const fileFieldId = (await json(fileFieldResponse)).data.field.id as string;
  const uploadResponse = await fetch(`${baseUrl}/api/v1/projects/${project.id}/fields/${fileFieldId}/attachment`, {
    method: 'POST',
    headers: { Cookie: ownerCookie, 'Content-Type': 'application/octet-stream', 'X-File-Name': 'design%20notes.txt' },
    body: Buffer.from('sample attachment contents'),
  });
  assert.equal(uploadResponse.status, 201);
  const attachment = (await json(uploadResponse)).data.field.value as { attachmentId: string; fileName: string };
  assert.equal(attachment.fileName, 'design notes.txt');
  const attachmentDownload = await fetch(`${baseUrl}/api/v1/projects/${project.id}/fields/${fileFieldId}/attachment/${attachment.attachmentId}`, { headers: { Cookie: ownerCookie } });
  assert.equal(attachmentDownload.status, 200);
  assert.equal(await attachmentDownload.text(), 'sample attachment contents');
  const fieldUpdate = await request(`/projects/${project.id}/fields/${customFieldId}`, { method: 'PATCH', cookie: ownerCookie, body: { value: 1500, pinned: true } });
  assert.equal((await json(fieldUpdate)).data.field.value, 1500);
  const bulkUpdate = await request(`/projects/${project.id}/fields/bulk`, {
    method: 'PATCH', cookie: ownerCookie,
    body: { updates: [{ fieldId: customTextId, value: 'Europe' }, { fieldId: customFieldId, value: 1700 }] },
  });
  assert.equal(bulkUpdate.status, 200);
  const allFields = (await json(bulkUpdate)).data.fields as Array<{ id: string; fieldName: string; value: unknown }>;
  assert.equal(allFields.find((field) => field.id === customTextId)?.value, 'Europe');
  assert.equal(allFields.find((field) => field.id === customFieldId)?.value, 1700);
  const renamedCustomField = await request(`/projects/${project.id}/fields/${customTextId}`, {
    method: 'PATCH', cookie: ownerCookie,
    body: { fieldName: 'Sales Region', fieldType: 'dropdown', value: 'EMEA', options: ['EMEA', 'Americas'], category: 'market', defaultValue: 'EMEA', required: true, displayOrder: 2, visibility: 'visible' },
  });
  assert.equal((await json(renamedCustomField)).data.field.fieldName, 'Sales Region');
  const orderedFields = await request(`/projects/${project.id}/fields/reorder`, {
    method: 'POST', cookie: ownerCookie,
    body: { fieldIds: [...allFields].reverse().map((field) => field.id) },
  });
  assert.equal(orderedFields.status, 200);
  assert.equal((await request(`/projects/${project.id}/fields/${customFieldId}`, { method: 'DELETE', cookie: ownerCookie })).status, 200);
  assert.equal((await request(`/projects/${project.id}/fields/${fileFieldId}`, { method: 'DELETE', cookie: ownerCookie })).status, 200);
  assert.equal((await fetch(`${baseUrl}/api/v1/projects/${project.id}/fields/${fileFieldId}/attachment/${attachment.attachmentId}`, { headers: { Cookie: ownerCookie } })).status, 404);

  const crossOriginMutation = await request('/projects/', {
    method: 'POST',
    cookie: ownerCookie,
    headers: { Origin: 'https://untrusted.example' },
    body: { name: 'Blocked cross-origin project', websiteUrl: 'https://example.org' },
  });
  assert.equal(crossOriginMutation.status, 403);
  assert.equal((await json(crossOriginMutation)).error.code, 'FORBIDDEN');

  const invalidProject = await request('/projects/', {
    method: 'POST',
    cookie: ownerCookie,
    body: { name: 'No sources' },
  });
  assert.equal(invalidProject.status, 400);
  assert.equal((await json(invalidProject)).error.code, 'VALIDATION_ERROR');

  const otherRegistration = await request('/auth/register', {
    method: 'POST',
    body: { name: 'Other User', email: `other-${Date.now()}@example.test`, password: 'Correct-Horse-13!' },
  });
  assert.equal(otherRegistration.status, 201);
  const otherCookie = sessionCookie(otherRegistration);
  const otherProjects = await request('/projects/', { cookie: otherCookie });
  assert.deepEqual((await json(otherProjects)).data.projects, []);
  assert.equal((await request(`/projects/${project.id}`, { cookie: otherCookie })).status, 404);
  assert.equal((await request(`/projects/${project.id}/fields`, { cookie: otherCookie })).status, 404);
  assert.equal((await request(`/projects/${project.id}/fields/${customFieldId}`, { method: 'PATCH', cookie: otherCookie, body: { value: 1 } })).status, 404);
  assert.equal((await request(`/analysis/projects/${project.id}/chat`, { cookie: otherCookie })).status, 404);
  assert.equal((await request(`/analysis/projects/${project.id}/chat`, { method: 'POST', cookie: otherCookie, body: { question: 'What database is used?' } })).status, 404);

  const unavailableChat = await request(`/analysis/projects/${project.id}/chat`, {
    method: 'POST', cookie: ownerCookie, body: { question: 'What is this project for?' },
  });
  assert.equal(unavailableChat.status, 503, 'chat should report missing Groq credentials rather than fabricate an answer');
  assert.deepEqual((await json(await request(`/analysis/projects/${project.id}/chat`, { cookie: ownerCookie }))).data.messages, [], 'failed provider requests are not persisted as complete conversations');

  const now = new Date().toISOString();
  const olderId = randomUUID();
  const newerId = randomUUID();
  const olderDate = new Date(Date.now() - 86_400_000).toISOString();
  database.prepare(`
    INSERT INTO case_studies (id, project_id, status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(olderId, project.id, 'completed', JSON.stringify({ executiveSummary: 'Earlier saved report.' }), olderDate, olderDate);
  database.prepare(`
    INSERT INTO case_studies (id, project_id, status, content_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(newerId, project.id, 'completed', JSON.stringify({ executiveSummary: 'Evidence-backed test report.', competitorComparison: [{ competitor: 'Sample alternative', source: 'https://competitor.example' }] }), now, now);

  const history = await request(`/analysis/projects/${project.id}/case-studies`, { cookie: ownerCookie });
  assert.equal(history.status, 200);
  assert.deepEqual((await json(history)).data.caseStudies.map((item: { id: string }) => item.id), [newerId, olderId]);
  const olderVersion = await request(`/analysis/projects/${project.id}/case-studies/${olderId}`, { cookie: ownerCookie });
  assert.equal((await json(olderVersion)).data.content.executiveSummary, 'Earlier saved report.');
  assert.equal((await request(`/analysis/projects/${project.id}/case-studies/${olderId}`, { cookie: otherCookie })).status, 404);
  assert.equal((await request(`/analysis/projects/${project.id}/case-studies/${newerId}/sections`, {
    method: 'POST', cookie: otherCookie, body: { action: 'replace', sectionKey: 'executiveSummary', replacement: 'Not authorized' },
  })).status, 404);
  const unavailableRewrite = await request(`/analysis/projects/${project.id}/case-studies/${newerId}/sections`, {
    method: 'POST', cookie: ownerCookie, body: { action: 'rewrite', sectionKey: 'executiveSummary', instruction: 'Make it clearer' },
  });
  assert.equal(unavailableRewrite.status, 503, 'AI section rewriting should report missing Groq credentials');

  const replacedSection = await request(`/analysis/projects/${project.id}/case-studies/${newerId}/sections`, {
    method: 'POST', cookie: ownerCookie, body: { action: 'replace', sectionKey: 'executiveSummary', replacement: 'Owner-edited executive summary.' },
  });
  assert.equal(replacedSection.status, 201);
  const replacedData = (await json(replacedSection)).data as { caseStudyId: string; content: Record<string, unknown> };
  assert.notEqual(replacedData.caseStudyId, newerId, 'section edits should preserve prior case-study versions');
  assert.equal(replacedData.content.executiveSummary, 'Owner-edited executive summary.');
  assert.equal((await json(await request(`/analysis/projects/${project.id}/case-studies/${newerId}`, { cookie: ownerCookie }))).data.content.executiveSummary, 'Evidence-backed test report.');
  const addedSection = await request(`/analysis/projects/${project.id}/case-studies/${replacedData.caseStudyId}/sections`, {
    method: 'POST', cookie: ownerCookie, body: { action: 'add', sectionTitle: 'Research Notes', replacement: 'Manual section added for the owner.' },
  });
  assert.equal(addedSection.status, 201);
  const addedData = (await json(addedSection)).data as { caseStudyId: string; content: Record<string, unknown> };
  assert.equal((addedData.content.customSections as Array<{ title: string }>)[0]?.title, 'Research Notes');
  const removedSection = await request(`/analysis/projects/${project.id}/case-studies/${addedData.caseStudyId}/sections`, {
    method: 'POST', cookie: ownerCookie, body: { action: 'remove', sectionKey: 'competitorComparison' },
  });
  assert.equal(removedSection.status, 201);
  const removedData = (await json(removedSection)).data as { caseStudyId: string; content: Record<string, unknown> };
  assert.equal(Object.hasOwn(removedData.content, 'competitorComparison'), false);
  await rebuildProjectKnowledgeIndex(project.id);
  const indexedLatestReport = database.prepare(`
    SELECT content FROM project_knowledge_chunks
    WHERE project_id = ? AND source_type = 'analysis' AND source_id LIKE ?
  `).all(project.id, `case-study-report:${removedData.caseStudyId}:%`) as Array<{ content: string }>;
  assert.ok(indexedLatestReport.length > 0, 'the latest saved and edited report should be included in project chat context');
  assert.match(indexedLatestReport.map((chunk) => chunk.content).join('\n'), /Owner-edited executive summary/);
  assert.match(indexedLatestReport.map((chunk) => chunk.content).join('\n'), /Research Notes/);

  const generated = await request(`/reports/projects/${project.id}/report`, { method: 'POST', cookie: ownerCookie, body: { caseStudyId: removedData.caseStudyId } });
  assert.equal(generated.status, 201);
  const report = (await json(generated)).data as { downloadUrl: string; fileName: string };
  assert.ok(report.fileName.startsWith(`${project.id}-`));
  const downloaded = await fetch(`${baseUrl}${report.downloadUrl}`, { headers: { Cookie: ownerCookie } });
  assert.equal(downloaded.status, 200);
  assert.match(downloaded.headers.get('content-type') ?? '', /application\/pdf/);
  const pdfBytes = await downloaded.arrayBuffer();
  assert.equal(pdfBytes.byteLength > 500, true);
  const parsedPdf = await PDFDocument.load(pdfBytes);
  assert.ok(parsedPdf.getPageCount() >= 3, 'report includes cover, contents, and report pages');
  const olderReport = await request(`/reports/projects/${project.id}/report`, { method: 'POST', cookie: ownerCookie, body: { caseStudyId: olderId } });
  assert.equal(olderReport.status, 201);
  const forgedFile = await request(`/reports/projects/${project.id}/report/download/another-project-report.pdf`, { cookie: ownerCookie });
  assert.equal(forgedFile.status, 404);
  assert.equal((await request(report.downloadUrl.replace('/api/v1', ''), { cookie: otherCookie })).status, 404);

  const logout = await request('/auth/logout', { method: 'POST', cookie: ownerCookie });
  assert.equal(logout.status, 200);
  assert.equal((await request('/projects/', { cookie: ownerCookie })).status, 401);

  assert.deepEqual(parseGitHubUrl('https://github.com/microsoft/vscode'), { owner: 'microsoft', repository: 'vscode' });
  assert.throws(() => parseGitHubUrl('https://github.com/microsoft'), /identify one owner and repository/);
  await assert.rejects(assertPublicUrl('http://127.0.0.1/admin'), /Private and local network addresses/);
  await assert.rejects(assertPublicUrl('http://100.64.0.1/'), /Private and local network addresses/);
  await assert.rejects(assertPublicUrl('http://[::ffff:127.0.0.1]/'), /Private and local network addresses/);
  await assert.rejects(assertPublicUrl('http://203.0.113.10/'), /Private and local network addresses/);

  const robots = parseRobotsTxt('User-agent: *\nDisallow: /\nUser-agent: CaseStudyTool\nDisallow: /private*\nAllow: /private/public$');
  assert.equal(isAllowedByRobots(new URL('https://example.com/'), robots), true);
  assert.equal(isAllowedByRobots(new URL('https://example.com/private/account'), robots), false);
  assert.equal(isAllowedByRobots(new URL('https://example.com/private/public'), robots), true);

  const caseStudy = await synthesizeCaseStudy({
    project: { name: 'Inventory Cloud', websiteUrl: 'https://inventory.example', githubUrl: null },
    website: {
      rootUrl: 'https://inventory.example',
      pages: [{ url: 'https://inventory.example/product', title: 'Inventory Cloud', description: 'Stock tracking for small shops', headings: ['Live inventory tracking'], text: 'Track stock across multiple shops.' }],
      warnings: [],
    },
    github: null,
  });
  assert.equal(caseStudy.synthesisStatus, 'fallback_no_provider');
  assert.match(String(caseStudy.websiteAnalysis), /https:\/\/inventory\.example\/product/);
  assert.match(String(caseStudy.executiveSummary), /Inventory Cloud/);
  assert.equal((caseStudy.profitabilityAnalysis as { status: string }).status, 'insufficient_data');
  assert.equal((caseStudy.projectClassification as { type: string }).type, 'insufficient_evidence');
  assert.equal(validateModelProjectClassification({ type: 'automation', confidence: 0.8, rationale: 'Repository describes a workflow automation product.' }).success, true);
  assert.equal(validateModelProjectClassification({ type: 'web3', confidence: 0.8, rationale: 'Unsupported classification.' }).success, false);
  const projectMeta = { name: 'Classifier test', websiteUrl: null, githubUrl: 'https://github.com/example/project' };
  assert.equal(classifyProjectType({ project: projectMeta, website: null, github: { metadata: {}, detectedTechnology: ['React'], dependencies: ['react'], structure: ['src/components/App.tsx'], languages: { TypeScript: 100 }, sourceInspection: {} } }).type, 'frontend');
  assert.equal(classifyProjectType({ project: projectMeta, website: null, github: { metadata: {}, detectedTechnology: ['Express.js'], dependencies: ['express'], structure: ['src/server.ts'], languages: { TypeScript: 100 }, sourceInspection: { apiRoutes: ['/api/items'] } } }).type, 'backend');
  assert.equal(classifyProjectType({ project: projectMeta, website: null, github: { metadata: { description: 'Workflow automation platform for business processes' }, detectedTechnology: [], dependencies: ['playwright'], structure: [], languages: {}, sourceInspection: {} } }).type, 'automation');
  assert.equal(validateModelSuggestedFields([{ fieldName: 'Deployment Frequency', fieldType: 'text', category: 'technical', description: 'Record a verified release cadence.' }]).success, true);
  assert.equal(validateModelSuggestedFields([{ fieldName: 'Unsupported', fieldType: 'secret', category: 'technical', description: 'Invalid type.' }]).success, false);
  const competitorSearch = await researchCompetitors('Inventory Cloud', { pages: [] }, ['https://inventory.example']);
  assert.equal(competitorSearch.status, 'not_configured');
  assert.equal(competitorSearch.results.length, 0);
  for (const section of ['executiveSummary', 'projectOverview', 'businessBackground', 'problemStatement', 'objectives', 'websiteAnalysis', 'technicalArchitecture', 'technologyStack', 'repositoryAnalysis', 'businessModel', 'targetAudience', 'marketAnalysis', 'competitorAnalysis', 'competitorComparison', 'businessScope', 'marketOpportunities', 'revenueModel', 'profitabilityAnalysis', 'risksAndLimitations', 'swotAnalysis', 'recommendations', 'growthStrategy', 'implementationRoadmap', 'conclusion']) {
    assert.ok(section in caseStudy, `fallback should include ${section}`);
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const failedLogin = await request('/auth/login', {
      method: 'POST',
      body: { email: `unknown-${attempt}@example.test`, password: 'Incorrect-Password-1!' },
    });
    assert.equal(failedLogin.status, 401);
  }
  const rateLimitedLogin = await request('/auth/login', {
    method: 'POST',
    body: { email: 'unknown-final@example.test', password: 'Incorrect-Password-1!' },
  });
  assert.equal(rateLimitedLogin.status, 429);
  assert.equal((await json(rateLimitedLogin)).error.code, 'RATE_LIMITED');
});
