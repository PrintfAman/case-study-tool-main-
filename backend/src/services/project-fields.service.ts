import { randomUUID } from 'node:crypto';
import { database } from '../storage/database';

export const FIELD_CATEGORIES = ['general', 'technical', 'business', 'product', 'market', 'financial', 'ai_insights', 'custom_fields'] as const;
export const FIELD_TYPES = ['text', 'long_text', 'number', 'currency', 'percentage', 'url', 'email', 'phone', 'date', 'date_time', 'boolean', 'dropdown', 'multi_select', 'tags', 'rich_text', 'json', 'file_attachment'] as const;
export const FIELD_SOURCES = ['AI', 'Website', 'GitHub', 'User', 'External API'] as const;

export type FieldCategory = typeof FIELD_CATEGORIES[number];
export type FieldType = typeof FIELD_TYPES[number];
export type FieldSource = typeof FIELD_SOURCES[number];

export interface ProjectFieldRow {
  id: string;
  project_id: string;
  field_key: string;
  category: string;
  field_name: string;
  field_type: string;
  value_json: string;
  ai_value_json: string | null;
  source: string;
  confidence_score: number | null;
  ai_source: string | null;
  ai_confidence_score: number | null;
  ai_generated_by: string | null;
  ai_updated_at: string | null;
  editable: number;
  required: number;
  read_only: number;
  default_value_json: string | null;
  description: string;
  options_json: string;
  display_order: number;
  visibility: string;
  pinned: number;
  is_suggested: number;
  suggestion_status: string | null;
  manual_notes: string;
  user_edited: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectField {
  id: string;
  projectId: string;
  key: string;
  category: string;
  fieldName: string;
  fieldType: string;
  value: unknown;
  aiValue: unknown;
  source: string;
  confidenceScore: number | null;
  aiSource: string | null;
  aiConfidenceScore: number | null;
  generatedBy: string | null;
  aiUpdatedAt: string | null;
  editable: boolean;
  required: boolean;
  readOnly: boolean;
  defaultValue: unknown;
  description: string;
  options: string[];
  displayOrder: number;
  visibility: string;
  pinned: boolean;
  suggested: boolean;
  suggestionStatus: string | null;
  manualNotes: string;
  userEdited: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AnalysisFieldCandidate {
  key: string;
  category: FieldCategory;
  name: string;
  type: FieldType;
  value: unknown;
  source: FieldSource;
  confidence: number | null;
  description?: string;
  generatedBy?: string;
  suggested?: boolean;
  options?: string[];
}

function parseJson(value: string | null): unknown {
  if (value === null) return null;
  try { return JSON.parse(value) as unknown; } catch { return null; }
}

export function serializeProjectField(row: ProjectFieldRow): ProjectField {
  const options = parseJson(row.options_json);
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.field_key,
    category: row.category,
    fieldName: row.field_name,
    fieldType: row.field_type,
    value: parseJson(row.value_json),
    aiValue: parseJson(row.ai_value_json),
    source: row.source,
    confidenceScore: row.confidence_score,
    aiSource: row.ai_source,
    aiConfidenceScore: row.ai_confidence_score,
    generatedBy: row.ai_generated_by,
    aiUpdatedAt: row.ai_updated_at,
    editable: Boolean(row.editable),
    required: Boolean(row.required),
    readOnly: Boolean(row.read_only),
    defaultValue: parseJson(row.default_value_json),
    description: row.description,
    options: Array.isArray(options) ? options.filter((item): item is string => typeof item === 'string') : [],
    displayOrder: row.display_order,
    visibility: row.visibility,
    pinned: Boolean(row.pinned),
    suggested: Boolean(row.is_suggested),
    suggestionStatus: row.suggestion_status,
    manualNotes: row.manual_notes,
    userEdited: Boolean(row.user_edited),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord).filter((record) => Object.keys(record).length > 0) : [];
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0) : [];
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function usefulAnalysisValue(value: unknown): unknown | null {
  if (typeof value === 'string') {
    const candidate = value.trim();
    if (!candidate || /^(not available|not reported|unknown|no data collected|no .* collected|could not be established)/i.test(candidate)) return null;
    if (/\b(not established|did not establish|could not be established|insufficient data|no competitor results were collected|no independent .* research was collected)\b/i.test(candidate)) return null;
    return candidate;
  }
  if (Array.isArray(value)) return value.length > 0 ? value : null;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.status === 'string' && /^(not_established|insufficient_data|not_configured|unavailable)$/i.test(record.status)) return null;
    return Object.keys(record).length > 0 ? value : null;
  }
  return value ?? null;
}

function inferFields(project: { id: string; name: string; websiteUrl: string | null; githubUrl: string | null }, content: Record<string, unknown>): AnalysisFieldCandidate[] {
  const fields: AnalysisFieldCandidate[] = [];
  const generatorBySource: Record<FieldSource, string> = {
    AI: 'Case study analysis', Website: 'Website crawler', GitHub: 'GitHub repository analyzer',
    User: 'Project setup', 'External API': 'External research provider',
  };
  const add = (candidate: AnalysisFieldCandidate) => {
    if (candidate.value !== null && candidate.value !== undefined && candidate.value !== '') {
      fields.push({ ...candidate, generatedBy: candidate.generatedBy ?? generatorBySource[candidate.source] });
    }
  };
  const evidence = asRecord(content.evidence);
  const website = asRecord(evidence.website);
  const pages = asRecords(website.pages);
  const rootPage = pages[0] ?? {};
  const metadata = asRecord(rootPage.metadata);
  const github = asRecord(evidence.github);
  const repoMetadata = asRecord(github.metadata);
  const sourceInspection = asRecord(github.sourceInspection);
  const tech = asStrings(github.detectedTechnology);
  const languages = Object.entries(asRecord(github.languages))
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .sort((a, b) => b[1] - a[1])
    .map(([language]) => language);
  const dependencies = asStrings(github.dependencies);
  const structure = asStrings(github.structure);
  const aiSource = 'AI';
  const generatedBy = text(content.synthesisStatus) ?? 'Evidence analysis';

  const classification = asRecord(content.projectClassification);
  const projectTypes: Record<string, string> = {
    frontend: 'Frontend', full_stack: 'Full Stack', backend: 'Backend', automation: 'Automation',
    insufficient_evidence: 'Not enough evidence',
  };
  const projectType = text(classification.type);
  if (projectType && Object.hasOwn(projectTypes, projectType)) {
    const groqClassified = content.projectClassificationSource === 'Groq';
    const source: FieldSource = groqClassified
      ? 'AI'
      : Object.keys(repoMetadata).length > 0 ? 'GitHub' : pages.length > 0 ? 'Website' : 'AI';
    add({
      key: 'project_type', category: 'technical', name: 'Project Type', type: 'dropdown',
      value: projectTypes[projectType], source,
      confidence: typeof classification.confidence === 'number' ? classification.confidence : 0,
      description: text(classification.rationale) ?? 'Classification from collected project source evidence.',
      generatedBy: groqClassified
        ? 'Groq project classification' : 'Evidence-based project classifier',
      options: ['Frontend', 'Full Stack', 'Backend', 'Automation', 'Not enough evidence'],
    });
  }

  add({ key: 'project_name', category: 'general', name: 'Project Name', type: 'text', value: project.name, source: 'User', confidence: 1, description: 'Name supplied when this project was created.' });
  if (project.websiteUrl) add({ key: 'website', category: 'general', name: 'Website', type: 'url', value: project.websiteUrl, source: 'User', confidence: 1 });
  if (project.githubUrl) add({ key: 'github_repository', category: 'technical', name: 'GitHub Repository', type: 'url', value: project.githubUrl, source: 'User', confidence: 1 });

  const siteName = text(metadata.siteName);
  const title = text(rootPage.title);
  const tagline = text(rootPage.description);
  const repoDescription = text(repoMetadata.description);
  if (siteName) add({ key: 'company_name', category: 'general', name: 'Company Name', type: 'text', value: siteName, source: 'Website', confidence: 0.88, description: 'Extracted from website Open Graph metadata.' });
  if (title) add({ key: 'product_name', category: 'general', name: 'Product Name', type: 'text', value: title, source: 'Website', confidence: 0.82 });
  if (tagline) add({ key: 'tagline', category: 'general', name: 'Tagline', type: 'long_text', value: tagline, source: 'Website', confidence: 0.86 });
  if (tagline || repoDescription) add({ key: 'description', category: 'general', name: 'Description', type: 'long_text', value: tagline ?? repoDescription, source: tagline ? 'Website' : 'GitHub', confidence: tagline ? 0.8 : 0.75 });
  if (languages.length) add({ key: 'programming_languages', category: 'technical', name: 'Programming Languages', type: 'tags', value: languages, source: 'GitHub', confidence: 0.97, description: 'Languages and byte counts reported by GitHub.' });

  const frontend = tech.filter((item) => /react|next|vue|nuxt|angular|svelte|solid|astro/i.test(item));
  const backend = tech.filter((item) => /express|fastify|nestjs|koa|hono|django|flask|fastapi|rails|spring|laravel/i.test(item));
  const database = [...asStrings(sourceInspection.databaseIndicators), ...tech.filter((item) => /database|orm|prisma|mongoose|sequelize|drizzle/i.test(item))];
  if (frontend.length) add({ key: 'frontend_framework', category: 'technical', name: 'Frontend Framework', type: 'tags', value: [...new Set(frontend)], source: 'GitHub', confidence: 0.82 });
  if (backend.length) add({ key: 'backend_framework', category: 'technical', name: 'Backend Framework', type: 'tags', value: [...new Set(backend)], source: 'GitHub', confidence: 0.76 });
  if (database.length) add({ key: 'database', category: 'technical', name: 'Database / ORM Indicators', type: 'tags', value: [...new Set(database)], source: 'GitHub', confidence: 0.62, description: 'Repository references only; verify the database actually used at runtime.' });
  if (dependencies.length) add({ key: 'dependencies', category: 'technical', name: 'Dependencies', type: 'long_text', value: dependencies.slice(0, 100), source: 'GitHub', confidence: 0.95 });
  const testingTools = dependencies.filter((dependency) => /jest|vitest|mocha|jasmine|pytest|unittest|playwright|cypress|selenium|testing-library|tap|ava/i.test(dependency));
  const testingFiles = structure.filter((path) => /(^|\/)(jest\.config|vitest\.config|pytest\.ini|tox\.ini|cypress\.config|playwright\.config)|\.(test|spec)\.[cm]?[jt]sx?$/i.test(path));
  if (testingTools.length || testingFiles.length) add({ key: 'testing_frameworks', category: 'technical', name: 'Testing Frameworks', type: 'tags', value: [...new Set([...testingTools, ...testingFiles])].slice(0, 20), source: 'GitHub', confidence: 0.8, description: 'Dependencies and test configuration paths found in the repository; presence does not establish test coverage.' });
  const authenticationTools = dependencies.filter((dependency) => /auth|passport|jsonwebtoken|jose|clerk|supabase|firebase|keycloak|oauth|lucia/i.test(dependency));
  if (authenticationTools.length) add({ key: 'authentication_indicators', category: 'technical', name: 'Authentication Dependencies', type: 'tags', value: authenticationTools.slice(0, 30), source: 'GitHub', confidence: 0.7, description: 'Authentication-related packages found in dependency manifests; verify how they are configured and used.' });
  const cloudTools = dependencies.filter((dependency) => /@aws-sdk|aws-sdk|@google-cloud|azure|@azure|cloudflare|vercel|netlify|firebase-admin/i.test(dependency));
  const cloudConfig = structure.filter((path) => /(^|\/)(serverless\.yml|serverless\.yaml|terraform\.tf|pulumi\.yaml|cloudformation|amplify\.yml|firebase\.json|wrangler\.toml)/i.test(path));
  if (cloudTools.length || cloudConfig.length) add({ key: 'cloud_provider_indicators', category: 'technical', name: 'Cloud Provider Indicators', type: 'tags', value: [...new Set([...cloudTools, ...cloudConfig])].slice(0, 30), source: 'GitHub', confidence: 0.65, description: 'Cloud SDK or deployment configuration references found in the repository; deployed infrastructure is not confirmed.' });
  const integrationPackages = dependencies.filter((dependency) => /stripe|twilio|sendgrid|resend|openai|groq|@slack|@linear|@sentry|supabase|firebase|aws-sdk|@aws-sdk|@google-cloud/i.test(dependency));
  if (integrationPackages.length) add({ key: 'external_api_sdk_dependencies', category: 'technical', name: 'External API / SDK Dependencies', type: 'tags', value: integrationPackages.slice(0, 40), source: 'GitHub', confidence: 0.68, description: 'External service SDK references found in dependencies; runtime integration and active use are not confirmed.' });
  const apiRoutes = asStrings(sourceInspection.apiRoutes);
  if (apiRoutes.length) add({ key: 'api_architecture', category: 'technical', name: 'API Architecture', type: 'long_text', value: apiRoutes, source: 'GitHub', confidence: 0.65, description: 'Routes detected in the bounded source-file sample.' });
  if (typeof repoMetadata.sizeKb === 'number') add({ key: 'repository_size_kb', category: 'technical', name: 'Repository Size (KB)', type: 'number', value: repoMetadata.sizeKb, source: 'GitHub', confidence: 1 });
  if (typeof repoMetadata.stars === 'number') add({ key: 'github_stars', category: 'technical', name: 'GitHub Stars', type: 'number', value: repoMetadata.stars, source: 'GitHub', confidence: 1 });
  if (typeof repoMetadata.forks === 'number') add({ key: 'github_forks', category: 'technical', name: 'GitHub Forks', type: 'number', value: repoMetadata.forks, source: 'GitHub', confidence: 1 });
  if (typeof repoMetadata.openIssues === 'number') add({ key: 'github_open_issues', category: 'technical', name: 'GitHub Open Issues', type: 'number', value: repoMetadata.openIssues, source: 'GitHub', confidence: 1, description: 'Current public GitHub open-issue count; not a product quality score.' });
  const buildTools = structure.filter((path) => /(^|\/)(vite\.config|webpack\.config|rollup\.config|tsconfig|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|cargo\.lock|poetry\.lock|requirements\.txt|gradlew|pom\.xml)/i.test(path));
  if (buildTools.length) add({ key: 'build_tools', category: 'technical', name: 'Build Tools and Manifests', type: 'tags', value: buildTools.slice(0, 30), source: 'GitHub', confidence: 0.86 });
  const ci = structure.filter((path) => /(^|\/)(\.github\/workflows\/|\.circleci\/|azure-pipelines\.yml|\.gitlab-ci\.yml)/i.test(path));
  if (ci.length) add({ key: 'ci_cd', category: 'technical', name: 'CI/CD', type: 'tags', value: ci.slice(0, 20), source: 'GitHub', confidence: 0.9 });
  const hosting = structure.filter((path) => /(^|\/)(vercel\.json|netlify\.toml|wrangler\.toml|firebase\.json|render\.yaml|fly\.toml|Dockerfile)$/i.test(path));
  if (hosting.length) add({ key: 'hosting_configuration', category: 'technical', name: 'Hosting Configuration', type: 'tags', value: hosting, source: 'GitHub', confidence: 0.7, description: 'Deployment configuration files found; deployed provider is not confirmed.' });
  const securitySignals = asStrings(sourceInspection.codeQuality);
  if (securitySignals.length) add({ key: 'repository_quality_signals', category: 'technical', name: 'Technical and Security Review Signals', type: 'long_text', value: securitySignals, source: 'GitHub', confidence: 0.5, description: 'Automated static indicators only; not a security audit.' });
  if (Array.isArray(rootPage.headings) && asStrings(rootPage.headings).length) add({ key: 'observed_features', category: 'product', name: 'Observed Product Sections', type: 'long_text', value: asStrings(rootPage.headings).slice(0, 30), source: 'Website', confidence: 0.55, description: 'Page headings; not all headings necessarily describe product features.' });
  const keywordList = asStrings(metadata.keywords);
  if (keywordList.length) add({ key: 'industry_keywords', category: 'market', name: 'Website Keywords', type: 'tags', value: keywordList, source: 'Website', confidence: 0.55, description: 'Website metadata keywords; not a verified industry classification.' });

  const reportFields: Array<[string, string, FieldCategory, FieldType]> = [
    ['businessModel', 'Business Model', 'business', 'long_text'],
    ['targetAudience', 'Target Audience', 'business', 'long_text'],
    ['revenueModel', 'Revenue Model', 'financial', 'long_text'],
    ['marketAnalysis', 'Market Analysis', 'market', 'long_text'],
    ['marketOpportunities', 'Market Opportunities', 'market', 'long_text'],
    ['competitorAnalysis', 'Competitors', 'market', 'long_text'],
    ['recommendations', 'Recommendations', 'ai_insights', 'long_text'],
    ['swotAnalysis', 'SWOT Summary', 'ai_insights', 'json'],
  ];
  for (const [key, name, category, type] of reportFields) {
    const value = usefulAnalysisValue(content[key]);
    if (value !== null) add({ key: `analysis_${key}`, category, name, type, value, source: aiSource, confidence: 0.55, generatedBy, description: 'Derived from the generated case study; review against its cited evidence.' });
  }

  const swot = asRecord(content.swotAnalysis);
  for (const key of ['strengths', 'weaknesses', 'opportunities', 'threats'] as const) {
    const value = usefulAnalysisValue(swot[key]);
    if (value !== null) add({ key: `swot_${key}`, category: 'ai_insights', name: key[0]!.toUpperCase() + key.slice(1), type: 'long_text', value, source: aiSource, confidence: 0.55, generatedBy, description: 'AI analysis of the collected source evidence.' });
  }

  const competitorEvidence = asRecord(evidence.competitors);
  const externalCompetitors = asRecords(competitorEvidence.results);
  if (externalCompetitors.length) add({
    key: 'external_competitor_results', category: 'market', name: 'Competitor Search Results', type: 'json',
    value: externalCompetitors.slice(0, 10), source: 'External API', confidence: 0.55,
    generatedBy: 'Tavily competitor search', description: 'Search results are candidate sources only; verify that each result is a direct competitor.',
  });

  const suggestions: AnalysisFieldCandidate[] = [];
  const suggest = (key: string, name: string, category: FieldCategory, type: FieldType, description: string) => suggestions.push({
    key: `suggested_${key}`, category, name, type, value: null, source: 'AI', confidence: 0.2,
    description, generatedBy: 'Field suggestions based on available project sources', suggested: true,
  });
  if (project.websiteUrl) suggest('estimated_traffic', 'Estimated Website Traffic', 'market', 'number', 'Optional enrichment: add a verified monthly visit estimate and cite its measurement source.');
  if (project.githubUrl) suggest('active_contributors', 'Active Contributors', 'technical', 'number', 'Optional enrichment: record contributor count and the time window used.');
  if (project.githubUrl) suggest('deployment_frequency', 'Deployment Frequency', 'technical', 'text', 'Optional enrichment: record verified release or deployment cadence.');
  if (project.githubUrl) {
    suggest('software_architecture_pattern', 'Software Architecture Pattern', 'technical', 'text', 'Record the verified pattern (for example, monolith, modular monolith, microservices, or serverless) and the source used to confirm it.');
    if (!fields.some((field) => field.key === 'testing_frameworks')) suggest('testing_framework', 'Testing Framework', 'technical', 'text', 'Record the test framework and representative test coverage after checking the repository and CI configuration.');
    if (!fields.some((field) => field.key === 'authentication_indicators')) suggest('authentication_approach', 'Authentication / Authorization Approach', 'technical', 'long_text', 'Document verified authentication and authorization methods; dependency presence alone is not sufficient.');
    if (!fields.some((field) => field.key === 'cloud_provider_indicators') && !fields.some((field) => field.key === 'hosting_configuration')) suggest('cloud_hosting_provider', 'Cloud / Hosting Provider', 'technical', 'text', 'Record the confirmed hosting or cloud provider and its source; repository configuration does not prove a live deployment.');
    if (!fields.some((field) => field.key === 'external_api_sdk_dependencies')) suggest('external_api_integrations', 'External API Integrations', 'technical', 'long_text', 'Record verified third-party APIs, what each integration does, and whether it is active in production.');
  }
  suggest('primary_customer_persona', 'Primary Customer Persona', 'business', 'long_text', 'Optional research field; validate with customer interviews.');
  suggest('funding_stage', 'Funding Stage', 'financial', 'dropdown', 'Optional enrichment; verify from a public company or funding source.');
  suggest('estimated_monthly_revenue', 'Estimated Monthly Revenue', 'financial', 'currency', 'Optional estimate; provide source, period, currency, and assumptions.');
  suggest('monthly_active_users', 'Monthly Active Users', 'product', 'number', 'Optional metric; enter only with a verified analytics source.');

  const suggestionNames = new Set([...fields, ...suggestions].map((field) => field.name.trim().toLowerCase()));
  const suggestionKeys = new Set(suggestions.map((field) => field.key));
  for (const proposed of asRecords(content.suggestedFields)) {
    const name = text(proposed.fieldName);
    const category = text(proposed.category);
    const type = text(proposed.fieldType);
    const description = text(proposed.description);
    if (!name || !description || !FIELD_CATEGORIES.includes(category as FieldCategory) || !FIELD_TYPES.includes(type as FieldType)) continue;
    const normalizedName = name.toLowerCase();
    if (suggestionNames.has(normalizedName)) continue;
    const slug = normalizedName.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 72);
    if (!slug) continue;
    const key = `suggested_ai_${slug}`;
    if (suggestionKeys.has(key)) continue;
    suggestions.push({
      key, category: category as FieldCategory, name, type: type as FieldType, value: null,
      source: 'AI', confidence: 0.35, description,
      generatedBy: content.synthesisStatus === 'ai_synthesis_completed_with_evidence_fallback' ? 'Groq report analysis' : 'AI field suggestions',
      suggested: true,
    });
    suggestionNames.add(normalizedName);
    suggestionKeys.add(key);
  }
  return [...fields, ...suggestions];
}

export function seedProjectFields(projectId: string, project: { name: string; websiteUrl: string | null; githubUrl: string | null }): void {
  const now = new Date().toISOString();
  const initial: Array<{ key: string; category: FieldCategory; name: string; type: FieldType; value: string }> = [
    { key: 'project_name', category: 'general', name: 'Project Name', type: 'text', value: project.name },
    ...(project.websiteUrl ? [{ key: 'website', category: 'general' as const, name: 'Website', type: 'url' as const, value: project.websiteUrl }] : []),
    ...(project.githubUrl ? [{ key: 'github_repository', category: 'technical' as const, name: 'GitHub Repository', type: 'url' as const, value: project.githubUrl }] : []),
  ];
  const insert = database.prepare(`
    INSERT OR IGNORE INTO project_fields (
      id, project_id, field_key, category, field_name, field_type, value_json, source,
      confidence_score, editable, user_edited, created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'User', 1, 1, 1, ?, ?, ?)
  `);
  for (const item of initial) {
    insert.run(randomUUID(), projectId, item.key, item.category, item.name, item.type, JSON.stringify(item.value), null, now, now);
  }
}

/** Upserts observed fields, retaining user values while keeping the latest AI value restorable. */
export function refreshProjectFields(project: { id: string; name: string; websiteUrl: string | null; githubUrl: string | null }, content: Record<string, unknown>): void {
  const now = new Date().toISOString();
  const candidates = inferFields(project, content);
  const getExisting = database.prepare('SELECT * FROM project_fields WHERE project_id = ? AND field_key = ?');
  const insert = database.prepare(`
    INSERT INTO project_fields (
      id, project_id, field_key, category, field_name, field_type, value_json, ai_value_json,
      source, confidence_score, ai_source, ai_confidence_score, ai_generated_by, ai_updated_at,
      editable, description, options_json, display_order, is_suggested, suggestion_status,
      user_edited, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateAi = database.prepare(`
    UPDATE project_fields SET
      category = ?, field_name = ?, field_type = ?,
      value_json = CASE WHEN user_edited = 1 THEN value_json ELSE ? END,
      source = CASE WHEN user_edited = 1 THEN source ELSE ? END,
      confidence_score = CASE WHEN user_edited = 1 THEN confidence_score ELSE ? END,
      ai_value_json = ?, ai_source = ?, ai_confidence_score = ?, ai_generated_by = ?, ai_updated_at = ?,
      description = CASE WHEN description = '' THEN ? ELSE description END,
      options_json = ?,
      is_suggested = CASE WHEN suggestion_status IN ('rejected', 'accepted', 'deleted') THEN 0 ELSE ? END,
      suggestion_status = CASE WHEN suggestion_status IN ('rejected', 'accepted', 'deleted') THEN suggestion_status ELSE ? END,
      updated_at = ?
    WHERE id = ?
  `);
  let order = 0;
  for (const candidate of candidates) {
      const existing = getExisting.get(project.id, candidate.key) as ProjectFieldRow | undefined;
      const valueJson = JSON.stringify(candidate.value);
      if (!existing) {
        const userSeed = candidate.source === 'User';
        const suggestionStatus = candidate.suggested ? 'pending' : null;
        insert.run(
          randomUUID(), project.id, candidate.key, candidate.category, candidate.name, candidate.type,
          valueJson, userSeed ? null : valueJson, candidate.source, candidate.confidence,
          userSeed ? null : candidate.source, candidate.confidence, candidate.generatedBy ?? null,
          userSeed ? null : now, candidate.description ?? '', JSON.stringify(candidate.options ?? []), order, candidate.suggested ? 1 : 0,
          suggestionStatus, userSeed ? 1 : 0, now, now,
        );
      } else if (candidate.source !== 'User' && !['rejected', 'accepted', 'deleted'].includes(existing.suggestion_status ?? '')) {
        updateAi.run(
          candidate.category, candidate.name, candidate.type, valueJson, candidate.source, candidate.confidence,
          valueJson, candidate.source, candidate.confidence, candidate.generatedBy ?? null, now,
          candidate.description ?? '', JSON.stringify(candidate.options ?? []), candidate.suggested ? 1 : 0,
          candidate.suggested ? 'pending' : null, now, existing.id,
        );
      }
      order += 1;
  }
}

