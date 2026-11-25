import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDirectory = mkdtempSync(join(tmpdir(), 'case-study-live-'));
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = join(testDirectory, 'live.sqlite');
process.env.REPORT_STORAGE_DIR = join(testDirectory, 'reports');
process.env.UPLOAD_STORAGE_DIR = join(testDirectory, 'uploads');
process.env.SESSION_SECRET = 'live-integration-session-secret-value';
process.env.GROQ_API_KEY = '';
process.env.TAVILY_API_KEY = '';

const [{ createApp }, { closeDatabase }] = await Promise.all([
  import('./src/app.ts'),
  import('./src/storage/database.ts'),
]);

const server = createServer(createApp());
let baseUrl = '';
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.off('error', reject);
    const address = server.address();
    if (!address || typeof address === 'string') return reject(new Error('No server address'));
    baseUrl = `http://127.0.0.1:${address.port}`;
    resolve();
  });
});

let cookie = '';
async function request(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers ?? {}) };
  if (cookie) headers.Cookie = cookie;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}/api/v1${path}`, { ...options, headers });
  const setCookie = response.headers.getSetCookie().find((value) => value.startsWith('cst_session='));
  if (setCookie) cookie = setCookie.split(';', 1)[0];
  const payload = await response.json();
  assert.equal(response.ok, true, `${options.method ?? 'GET'} ${path} failed: ${payload.message}`);
  return payload.data;
}

try {
  const email = `live-${Date.now()}@example.test`;
  await request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Live Integration User', email, password: 'Integration-Pass-123!' }),
  });
  const project = await request('/projects/', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Example Domain Repository Analysis',
      websiteUrl: 'https://example.com',
      githubUrl: 'https://github.com/octocat/Hello-World',
    }),
  });

  const analysis = await request(`/analysis/projects/${project.id}/analyze`, { method: 'POST' });
  assert.equal(analysis.projectId, project.id);
  assert.ok(analysis.caseStudyId);
  assert.ok(Array.isArray(analysis.content.evidence.website.pages));
  assert.ok(analysis.content.evidence.website.pages.length > 0, 'crawler should collect the Example Domain page');
  assert.equal(analysis.content.evidence.github.repository, 'Hello-World');
  assert.equal(analysis.content.synthesisStatus, 'fallback_no_provider');

  const projectInformation = await request(`/projects/${project.id}/fields`);
  assert.ok(projectInformation.fields.some((field) => field.key === 'project_name' && field.value === project.name));
  assert.ok(projectInformation.fields.some((field) => field.key === 'github_stars' && field.source === 'GitHub'));
  const websiteField = projectInformation.fields.find((field) => field.source === 'Website');
  assert.ok(websiteField, 'crawler output should populate at least one website-derived project field');
  assert.ok(projectInformation.fields.some((field) => field.suggested && field.suggestionStatus === 'pending'));

  const history = await request(`/analysis/projects/${project.id}/case-studies`);
  assert.equal(history.caseStudies.length, 1);
  assert.equal(history.caseStudies[0].id, analysis.caseStudyId);

  const report = await request(`/reports/projects/${project.id}/report`, { method: 'POST' });
  const download = await fetch(`${baseUrl}${report.downloadUrl}`, { headers: { Cookie: cookie } });
  assert.equal(download.status, 200);
  const bytes = new Uint8Array(await download.arrayBuffer());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 4)), '%PDF');

  console.log(JSON.stringify({
    status: analysis.status,
    websitePages: analysis.content.evidence.website.pages.length,
    githubRepository: analysis.content.evidence.github.repository,
    synthesis: analysis.content.synthesisStatus,
    websiteField: websiteField.fieldName,
    projectFields: projectInformation.fields.length,
    pendingFieldSuggestions: projectInformation.fields.filter((field) => field.suggested && field.suggestionStatus === 'pending').length,
    historyVersions: history.caseStudies.length,
    pdfBytes: bytes.length,
    pdfFile: report.fileName,
  }));
} finally {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  closeDatabase();
  rmSync(testDirectory, { recursive: true, force: true });
}
