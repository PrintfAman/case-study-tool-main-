import { database } from '../storage/database';
import { AppError } from '../utils/app-error';
import { analyzeGitHubRepository } from './github-analyzer.service';
import { crawlWebsite } from './website-crawler.service';
import { researchCompetitors } from './competitor-research.service';
import { synthesizeCaseStudy } from './case-study.service';
import { refreshProjectFields } from './project-fields.service';
import { rebuildProjectKnowledgeIndex } from './project-knowledge.service';

export interface ProjectSourceRecord {
  projectId: string;
  status: 'running' | 'completed' | 'completed_with_warnings' | 'failed';
  evidence: {
    website: unknown | null;
    github: unknown | null;
    competitors: unknown | null;
    sourceWarnings: string[];
  };
  fieldAnalysis: Record<string, unknown>;
  warnings: string[];
  updatedAt: string;
}

interface ProjectSourceRow {
  project_id: string;
  name: string;
  website_url: string | null;
  github_url: string | null;
}

function readSourceRecord(projectId: string): ProjectSourceRecord | null {
  const row = database.prepare(`
    SELECT project_id, status, evidence_json, field_analysis_json, warnings_json, updated_at
    FROM project_source_analyses WHERE project_id = ?
  `).get(projectId) as {
    project_id: string;
    status: ProjectSourceRecord['status'];
    evidence_json: string;
    field_analysis_json: string;
    warnings_json: string;
    updated_at: string;
  } | undefined;
  if (!row) return null;

  try {
    const evidence = JSON.parse(row.evidence_json) as ProjectSourceRecord['evidence'];
    const fieldAnalysis = JSON.parse(row.field_analysis_json) as Record<string, unknown>;
    const warnings = JSON.parse(row.warnings_json) as string[];
    return { projectId: row.project_id, status: row.status, evidence, fieldAnalysis, warnings, updatedAt: row.updated_at };
  } catch {
    throw new AppError('Saved project source information is invalid. Retry field collection.', {
      statusCode: 500,
      code: 'INTERNAL_ERROR',
    });
  }
}

async function refreshKnowledgeIndex(projectId: string, record: ProjectSourceRecord): Promise<ProjectSourceRecord> {
  try {
    await rebuildProjectKnowledgeIndex(projectId);
    return record;
  } catch (error) {
    const warning = `Project knowledge indexing unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`;
    const warnings = [...record.warnings, warning];
    const status = 'completed_with_warnings' as const;
    const updatedAt = new Date().toISOString();
    database.prepare(`
      UPDATE project_source_analyses SET status = ?, warnings_json = ?, updated_at = ? WHERE project_id = ?
    `).run(status, JSON.stringify(warnings), updatedAt, projectId);
    return { ...record, status, warnings, updatedAt };
  }
}

/** Collects website/repository evidence once, creates the project fields, and saves the evidence for later report generation. */
export async function ensureProjectInformation(projectId: string, userId: string, refresh = false): Promise<ProjectSourceRecord> {
  const project = database.prepare(`
    SELECT id AS project_id, name, website_url, github_url
    FROM projects WHERE id = ? AND user_id = ?
  `).get(projectId, userId) as ProjectSourceRow | undefined;
  if (!project) throw AppError.notFound('Project');

  const existing = readSourceRecord(projectId);
  if (!refresh && existing && (existing.status === 'completed' || existing.status === 'completed_with_warnings')) {
    return refreshKnowledgeIndex(projectId, existing);
  }
  if (existing?.status === 'running' && Date.now() - Date.parse(existing.updatedAt) < 10 * 60 * 1000) {
    throw new AppError('Project information is already being collected', { statusCode: 409, code: 'CONFLICT' });
  }

  const startedAt = new Date().toISOString();
  database.prepare(`
    INSERT INTO project_source_analyses (project_id, status, evidence_json, field_analysis_json, warnings_json, updated_at)
    VALUES (?, 'running', '{}', '{}', '[]', ?)
    ON CONFLICT(project_id) DO UPDATE SET
      status = 'running', evidence_json = '{}', field_analysis_json = '{}', warnings_json = '[]', updated_at = ?
  `).run(projectId, startedAt, startedAt);

  const warnings: string[] = [];
  let website: unknown | null = null;
  let github: unknown | null = null;
  let competitors: unknown | null = null;

  try {
    if (project.website_url) {
      try {
        website = await crawlWebsite(project.website_url, 6);
        const websiteWarnings = (website as { warnings?: unknown } | null)?.warnings;
        if (Array.isArray(websiteWarnings)) warnings.push(...websiteWarnings.filter((item): item is string => typeof item === 'string'));
      } catch (error) {
        warnings.push(`Website information unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    if (project.github_url) {
      try {
        github = await analyzeGitHubRepository(project.github_url);
      } catch (error) {
        warnings.push(`GitHub information unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    try {
      competitors = await researchCompetitors(project.name, website, [project.website_url, project.github_url]);
      const competitorWarning = (competitors as { warning?: unknown } | null)?.warning;
      if (typeof competitorWarning === 'string') warnings.push(competitorWarning);
    } catch (error) {
      warnings.push(`Competitor research unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    const fieldAnalysis = await synthesizeCaseStudy({
      project: { name: project.name, websiteUrl: project.website_url, githubUrl: project.github_url },
      website,
      github,
      competitors,
    });
    if (fieldAnalysis.synthesisStatus === 'fallback_no_provider') {
      warnings.push('AI field enrichment is not configured; website and GitHub fields were populated where available.');
    } else if (typeof fieldAnalysis.synthesisWarning === 'string') {
      warnings.push(fieldAnalysis.synthesisWarning);
    }

    const evidence = { website, github, competitors, sourceWarnings: warnings };
    const status = warnings.length > 0 ? 'completed_with_warnings' : 'completed';
    const finishedAt = new Date().toISOString();
    const projectForFields = { id: project.project_id, name: project.name, websiteUrl: project.website_url, githubUrl: project.github_url };
    const fieldsContent = { ...fieldAnalysis, evidence, sourceWarnings: warnings };

    database.exec('BEGIN IMMEDIATE');
    try {
      refreshProjectFields(projectForFields, fieldsContent);
      database.prepare(`
        UPDATE project_source_analyses
        SET status = ?, evidence_json = ?, field_analysis_json = ?, warnings_json = ?, updated_at = ?
        WHERE project_id = ?
      `).run(status, JSON.stringify(evidence), JSON.stringify(fieldAnalysis), JSON.stringify(warnings), finishedAt, projectId);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }

    return refreshKnowledgeIndex(projectId, { projectId, status, evidence, fieldAnalysis, warnings, updatedAt: finishedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Project information collection failed';
    database.prepare(`
      UPDATE project_source_analyses SET status = 'failed', warnings_json = ?, updated_at = ? WHERE project_id = ?
    `).run(JSON.stringify([message]), new Date().toISOString(), projectId);
    throw error;
  }
}

export function getFinalizedProjectInformation(projectId: string): Array<Record<string, unknown>> {
  const rows = database.prepare(`
    SELECT field_name, field_type, category, value_json, source, description, manual_notes
    FROM project_fields
    WHERE project_id = ? AND visibility = 'visible'
      AND (is_suggested = 0 OR suggestion_status = 'accepted')
    ORDER BY display_order ASC, field_name COLLATE NOCASE ASC
    LIMIT 200
  `).all(projectId) as Array<{
    field_name: string;
    field_type: string;
    category: string;
    value_json: string;
    source: string;
    description: string;
    manual_notes: string;
  }>;

  return rows.flatMap((row) => {
    let value: unknown;
    try { value = JSON.parse(row.value_json) as unknown; } catch { return []; }
    if (value == null || value === '') return [];
    return [{
      fieldName: row.field_name,
      fieldType: row.field_type,
      category: row.category,
      value,
      source: row.source,
      description: row.description,
      userNotes: row.manual_notes,
    }];
  });
}
