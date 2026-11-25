import { createHash, randomUUID } from 'node:crypto';
import { database } from '../storage/database';

const VECTOR_DIMENSIONS = 256;
const CHUNK_CHARACTERS = 1_600;
const CHUNK_OVERLAP = 180;
const MAX_RETRIEVAL_RESULTS = 12;

export interface ProjectKnowledgeCitation {
  id: string;
  sourceType: string;
  title: string;
  url: string | null;
  score: number;
  content: string;
}

interface KnowledgeDocument {
  sourceType: 'website' | 'github' | 'analysis' | 'metadata' | 'project_field';
  sourceId: string;
  title: string;
  url: string | null;
  content: string;
  metadata: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function strings(value: unknown, maximum = 100): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, maximum) : [];
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function splitIntoChunks(text: string): string[] {
  const normalized = text.replace(/\r/g, '').trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + CHUNK_CHARACTERS);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf(' ', end);
      if (boundary > start + Math.floor(CHUNK_CHARACTERS * 0.65)) end = boundary;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  return chunks;
}

function appendDocuments(
  target: KnowledgeDocument[],
  sourceType: KnowledgeDocument['sourceType'],
  sourceId: string,
  title: string,
  url: string | null,
  text: string,
  metadata: Record<string, unknown> = {},
): void {
  splitIntoChunks(text).forEach((content, index) => target.push({
    sourceType,
    sourceId: `${sourceId}:${index}`,
    title,
    url,
    content,
    metadata,
  }));
}

async function createDocuments(projectId: string): Promise<KnowledgeDocument[]> {
  const project = await database.prepare('SELECT id, name, website_url, github_url FROM projects WHERE id = ?').get(projectId) as {
    id: string; name: string; website_url: string | null; github_url: string | null;
  } | undefined;
  if (!project) return [];

  const source = await database.prepare(`
    SELECT evidence_json, field_analysis_json, updated_at
    FROM project_source_analyses WHERE project_id = ?
  `).get(projectId) as { evidence_json: string; field_analysis_json: string; updated_at: string } | undefined;
  let evidence: Record<string, unknown> = {};
  let fieldAnalysis: Record<string, unknown> = {};
  if (source) {
    try { evidence = asRecord(JSON.parse(source.evidence_json)); } catch { /* Keep project metadata searchable when old evidence is malformed. */ }
    try { fieldAnalysis = asRecord(JSON.parse(source.field_analysis_json)); } catch { /* Keep project metadata searchable when old analysis is malformed. */ }
  }

  const documents: KnowledgeDocument[] = [];
  appendDocuments(
    documents,
    'metadata',
    'project',
    `${project.name} project profile`,
    project.website_url,
    JSON.stringify({ name: project.name, website: project.website_url, githubRepository: project.github_url }, null, 2),
    { source: 'project_metadata' },
  );

  const website = asRecord(evidence.website);
  for (const [pageIndex, page] of asRecords(website.pages).entries()) {
    const url = typeof page.url === 'string' ? page.url : null;
    const title = typeof page.title === 'string' && page.title ? page.title : url ?? `Website page ${pageIndex + 1}`;
    const metadata = asRecord(page.metadata);
    const body = [
      `Page title: ${title}`,
      `URL: ${url ?? 'not recorded'}`,
      typeof page.description === 'string' ? `Description: ${page.description}` : '',
      `Headings: ${strings(page.headings, 40).join(' | ')}`,
      `Metadata: ${JSON.stringify(metadata)}`,
      `Website content: ${typeof page.text === 'string' ? page.text : ''}`,
    ].filter(Boolean).join('\n');
    appendDocuments(documents, 'website', url ?? `page-${pageIndex}`, title, url, body, { pageIndex, metadata });
  }

  const github = asRecord(evidence.github);
  if (Object.keys(github).length > 0) {
    const repository = typeof github.url === 'string' ? github.url : project.github_url;
    const githubSummary = { ...github };
    delete githubSummary.readme;
    delete githubSummary.documentation;
    appendDocuments(
      documents,
      'github',
      'repository-summary',
      `${String(github.repository ?? project.name)} repository analysis`,
      repository,
      `GitHub repository analysis and bounded source inspection summary:\n${JSON.stringify(githubSummary, null, 2)}`,
      { repository, analyzedAt: github.analyzedAt ?? null },
    );
    const readme = asRecord(github.readme);
    if (typeof readme.content === 'string' && readme.content) {
      const path = typeof readme.path === 'string' ? readme.path : 'README';
      appendDocuments(documents, 'github', `readme:${path}`, `Repository README (${path})`, repository, readme.content, { path, documentType: 'readme' });
    }
    for (const document of asRecords(github.documentation)) {
      if (typeof document.content !== 'string' || !document.content) continue;
      const path = typeof document.path === 'string' ? document.path : 'documentation';
      appendDocuments(documents, 'github', `documentation:${path}`, `Repository documentation (${path})`, repository, document.content, { path, documentType: 'documentation' });
    }
  }

  const competitors = asRecord(evidence.competitors);
  if (Object.keys(competitors).length > 0) {
    appendDocuments(documents, 'analysis', 'competitor-research', 'Competitor research', null, JSON.stringify(competitors, null, 2), { source: 'external_research' });
  }
  if (Object.keys(fieldAnalysis).length > 0) {
    appendDocuments(documents, 'analysis', 'ai-analysis', 'AI project analysis', null, JSON.stringify(fieldAnalysis, null, 2), {
      generatedAt: source?.updated_at ?? null,
      synthesisStatus: fieldAnalysis.synthesisStatus ?? null,
    });
  }
  const latestCaseStudy = await database.prepare(`
    SELECT id, status, content_json, updated_at
    FROM case_studies WHERE project_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(projectId) as { id: string; status: string; content_json: string; updated_at: string } | undefined;
  if (latestCaseStudy) {
    try {
      const report = asRecord(JSON.parse(latestCaseStudy.content_json));
      const reportText = Object.entries(report)
        .filter(([key, value]) => !['evidence', 'sourceWarnings'].includes(key) && value !== null && value !== undefined)
        .map(([key, value]) => {
          const title = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (character) => character.toUpperCase());
          return `Report section: ${title}\n${displayValue(value)}`;
        })
        .join('\n\n');
      appendDocuments(documents, 'analysis', `case-study-report:${latestCaseStudy.id}`, 'Latest saved case study', null, reportText, {
        caseStudyId: latestCaseStudy.id,
        status: latestCaseStudy.status,
        updatedAt: latestCaseStudy.updated_at,
      });
    } catch {
      // Invalid report JSON should not prevent the source and project-field index from being refreshed.
    }
  }
  if (Array.isArray(evidence.sourceWarnings) && evidence.sourceWarnings.length > 0) {
    appendDocuments(documents, 'metadata', 'source-warnings', 'Source collection limitations', null, strings(evidence.sourceWarnings).join('\n'), { source: 'analysis_warning' });
  }

  const fields = await database.prepare(`
    SELECT id, field_name, field_type, category, value_json, source, description, manual_notes, ai_generated_by
    FROM project_fields
    WHERE project_id = ? AND visibility = 'visible'
      AND (is_suggested = 0 OR suggestion_status = 'accepted')
  `).all(projectId) as Array<{
    id: string; field_name: string; field_type: string; category: string; value_json: string;
    source: string; description: string; manual_notes: string; ai_generated_by: string | null;
  }>;
  for (const field of fields) {
    let value: unknown;
    try { value = JSON.parse(field.value_json) as unknown; } catch { continue; }
    if (value === null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    const content = [
      `Field: ${field.field_name}`,
      `Category: ${field.category}`,
      `Type: ${field.field_type}`,
      `Value: ${displayValue(value)}`,
      `Source: ${field.source}`,
      field.description ? `Description: ${field.description}` : '',
      field.manual_notes ? `Project owner notes: ${field.manual_notes}` : '',
      field.ai_generated_by ? `Generated by: ${field.ai_generated_by}` : '',
    ].filter(Boolean).join('\n');
    appendDocuments(documents, 'project_field', field.id, field.field_name, null, content, {
      fieldId: field.id, category: field.category, source: field.source,
    });
  }

  return documents;
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function desiredEmbeddingModel(): string {
  return 'local-hash-v1';
}

function hashFeature(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Deterministic local vectors provide candidate retrieval before Groq relevance ranking. */
function localEmbedding(text: string): number[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_+#.-]{2,}/gu) ?? [];
  const features = [...words, ...words.slice(0, -1).map((word, index) => `${word}_${words[index + 1]}`)];
  const vector = new Array<number>(VECTOR_DIMENSIONS).fill(0);
  for (const feature of features) vector[hashFeature(feature) % VECTOR_DIMENSIONS] += 1;
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return magnitude === 0 ? vector : vector.map((value) => value / magnitude);
}

function parseVector(serialized: string): number[] | null {
  try {
    const value: unknown = JSON.parse(serialized);
    return Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isFinite(item)) ? value : null;
  } catch { return null; }
}

/** Rebuilds the project's bounded, isolated vector index from saved source evidence and current fields. */
export async function rebuildProjectKnowledgeIndex(projectId: string): Promise<{ chunkCount: number; embeddingModel: string }> {
  const documents = await createDocuments(projectId);
  const existing = await database.prepare(`
    SELECT id, source_type, source_id, content_hash, embedding_json, embedding_model, created_at
    FROM project_knowledge_chunks WHERE project_id = ?
  `).all(projectId) as Array<{ id: string; source_type: string; source_id: string; content_hash: string; embedding_json: string; embedding_model: string; created_at: string }>;
  const oldByKey = new Map(existing.map((row) => [`${row.source_type}\u0000${row.source_id}`, row]));
  const desiredModel = desiredEmbeddingModel();
  const hashes = documents.map((document) => hashText(document.content));
  const canReuse = documents.every((document, index) => {
    const old = oldByKey.get(`${document.sourceType}\u0000${document.sourceId}`);
    return old?.content_hash === hashes[index] && old.embedding_model === desiredModel && parseVector(old.embedding_json) !== null;
  });
  if (canReuse && existing.length === documents.length) {
    return { chunkCount: documents.length, embeddingModel: desiredModel };
  }

  const embeddingModel = desiredModel;
  let embeddings: number[][];
  if (canReuse) {
    embeddings = documents.map((document) => {
      const old = oldByKey.get(`${document.sourceType}\u0000${document.sourceId}`);
      return old ? parseVector(old.embedding_json) ?? localEmbedding(document.content) : localEmbedding(document.content);
    });
  } else {
    embeddings = documents.map((document) => localEmbedding(document.content));
  }

  const now = new Date().toISOString();
  await database.transaction(async () => {
    const upsert = database.prepare(`
      INSERT INTO project_knowledge_chunks (
        id, project_id, source_type, source_id, title, source_url, content,
        metadata_json, content_hash, embedding_json, embedding_model, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, source_type, source_id) DO UPDATE SET
        title = excluded.title, source_url = excluded.source_url, content = excluded.content,
        metadata_json = excluded.metadata_json, content_hash = excluded.content_hash,
        embedding_json = excluded.embedding_json, embedding_model = excluded.embedding_model,
        updated_at = excluded.updated_at
    `);
    const keep = new Set(documents.map((document) => `${document.sourceType}\u0000${document.sourceId}`));
    for (let index = 0; index < documents.length; index += 1) {
      const document = documents[index];
      const embedding = embeddings[index];
      if (!document || !embedding) continue;
      const old = oldByKey.get(`${document.sourceType}\u0000${document.sourceId}`);
      await upsert.run(
        old?.id ?? randomUUID(),
        projectId, document.sourceType, document.sourceId, document.title, document.url,
        document.content, JSON.stringify(document.metadata), hashes[index], JSON.stringify(embedding),
        embeddingModel, old?.created_at ?? now, now,
      );
    }
    const current = await database.prepare('SELECT source_type, source_id FROM project_knowledge_chunks WHERE project_id = ?').all(projectId) as Array<{ source_type: string; source_id: string }>;
    const remove = database.prepare('DELETE FROM project_knowledge_chunks WHERE project_id = ? AND source_type = ? AND source_id = ?');
    for (const row of current) if (!keep.has(`${row.source_type}\u0000${row.source_id}`)) await remove.run(projectId, row.source_type, row.source_id);
  });
  return { chunkCount: documents.length, embeddingModel };
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  return leftMagnitude === 0 || rightMagnitude === 0 ? 0 : dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

/** Returns only ranked chunks from the requested project, never another project's rows. */
export async function retrieveProjectKnowledge(projectId: string, query: string, limit = MAX_RETRIEVAL_RESULTS): Promise<ProjectKnowledgeCitation[]> {
  await rebuildProjectKnowledgeIndex(projectId);
  const rows = await database.prepare(`
    SELECT id, source_type AS "sourceType", title, source_url AS url, content,
      embedding_json AS "embeddingJson", embedding_model AS "embeddingModel"
    FROM project_knowledge_chunks WHERE project_id = ?
  `).all(projectId) as Array<{
    id: string; sourceType: string; title: string; url: string | null; content: string; embeddingJson: string; embeddingModel: string;
  }>;
  if (rows.length === 0) return [];

  const queryEmbedding = localEmbedding(query);

  return rows.map((row) => {
    const stored = parseVector(row.embeddingJson) ?? localEmbedding(row.content);
    return {
      id: row.id,
      sourceType: row.sourceType,
      title: row.title,
      url: row.url,
      score: cosineSimilarity(queryEmbedding, stored),
      content: row.content.slice(0, CHUNK_CHARACTERS),
    };
  }).sort((left, right) => right.score - left.score).slice(0, Math.max(1, Math.min(MAX_RETRIEVAL_RESULTS, limit)));
}

export async function getProjectChatHistory(projectId: string): Promise<Array<{ id: string; role: 'user' | 'assistant'; content: string; citations: Array<{ id: string; sourceType: string; title: string; url: string | null }>; createdAt: string }>> {
  const rows = await database.prepare(`
    SELECT id, role, content, citations_json, created_at FROM (
      SELECT id, role, content, citations_json, created_at
      FROM project_chat_messages WHERE project_id = ? ORDER BY created_at DESC LIMIT 100
    ) ORDER BY created_at ASC
  `).all(projectId) as Array<{ id: string; role: 'user' | 'assistant'; content: string; citations_json: string; created_at: string }>;
  return rows.map((row) => {
    let citations: Array<{ id: string; sourceType: string; title: string; url: string | null }> = [];
    try { citations = JSON.parse(row.citations_json) as typeof citations; } catch { /* Corrupt citation metadata does not hide chat text. */ }
    return { id: row.id, role: row.role, content: row.content, citations, createdAt: row.created_at };
  });
}
