import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import { database } from '../storage/database';
import { AppError } from '../utils/app-error';
import { successResponse } from '../utils/api-response';
import { analyzeGitHubRepository } from '../services/github-analyzer.service';
import { crawlWebsite } from '../services/website-crawler.service';
import { synthesizeCaseStudy } from '../services/case-study.service';
import { researchCompetitors } from '../services/competitor-research.service';
import { refreshProjectFields } from '../services/project-fields.service';

interface ProjectRow {
  id: string;
  name: string;
  website_url: string | null;
  github_url: string | null;
  status: string;
}

export async function runAnalysis(req: Request, res: Response): Promise<void> {
  const userId = (req as AuthenticatedRequest).user.id;
  const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const project = database.prepare('SELECT id, name, website_url, github_url, status FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId) as unknown as ProjectRow | undefined;
  if (!project) throw AppError.notFound('Project');

  const claimed = database.prepare("UPDATE projects SET status = 'analyzing', updated_at = ? WHERE id = ? AND user_id = ? AND status <> 'analyzing'").run(new Date().toISOString(), project.id, userId);
  if (claimed.changes === 0) throw new AppError('Analysis is already running for this project', { statusCode: 409, code: 'CONFLICT' });

  try {
    let website: unknown | null = null;
    let github: unknown | null = null;
    const sourceWarnings: string[] = [];

    if (project.website_url) {
      try {
        website = await crawlWebsite(project.website_url, 6);
      } catch (error) {
        sourceWarnings.push(`Website analysis unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    if (project.github_url) {
      try {
        github = await analyzeGitHubRepository(project.github_url);
      } catch (error) {
        sourceWarnings.push(`GitHub analysis unavailable: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    const competitors = await researchCompetitors(project.name, website, [project.website_url, project.github_url]);
    if (competitors.warning) sourceWarnings.push(competitors.warning);

    const content = await synthesizeCaseStudy({
      project: { name: project.name, websiteUrl: project.website_url, githubUrl: project.github_url },
      website,
      github,
      competitors,
    });

    const status = sourceWarnings.length > 0 ? 'completed_with_warnings' : 'completed';
    const id = randomUUID();
    const now = new Date().toISOString();
    const persistedContent = { ...content, evidence: { website, github, competitors }, sourceWarnings };
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(`
        INSERT INTO case_studies (id, project_id, status, content_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, project.id, status, JSON.stringify(persistedContent), now, now);
      refreshProjectFields({ id: project.id, name: project.name, websiteUrl: project.website_url, githubUrl: project.github_url }, persistedContent);
      database.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(status, now, project.id, userId);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }

    res.status(200).json(successResponse({ projectId: project.id, caseStudyId: id, status, content: persistedContent }, 'Analysis completed'));
  } catch (error) {
    database.prepare("UPDATE projects SET status = 'failed', updated_at = ? WHERE id = ? AND user_id = ? AND status = 'analyzing'").run(new Date().toISOString(), project.id, userId);
    throw error;
  }
}

export function getCaseStudy(req: Request, res: Response): void {
  const userId = (req as AuthenticatedRequest).user.id;
  const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const row = database.prepare(`
    SELECT c.* FROM case_studies c
    JOIN projects p ON p.id = c.project_id
    WHERE c.project_id = ? AND p.user_id = ?
    ORDER BY c.created_at DESC LIMIT 1
  `).get(projectId, userId) as unknown as { id: string; content_json: string; status: string; created_at: string; updated_at: string } | undefined;
  if (!row) throw AppError.notFound('Case study');
  res.status(200).json(successResponse({ id: row.id, status: row.status, content: JSON.parse(row.content_json), createdAt: row.created_at, updatedAt: row.updated_at }, 'Case study retrieved'));
}

export function listCaseStudies(req: Request, res: Response): void {
  const userId = (req as AuthenticatedRequest).user.id;
  const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const ownsProject = database.prepare('SELECT id FROM projects WHERE id = ? AND user_id = ?').get(projectId, userId);
  if (!ownsProject) throw AppError.notFound('Project');
  const rows = database.prepare(`
    SELECT id, status, created_at, updated_at
    FROM case_studies WHERE project_id = ?
    ORDER BY created_at DESC LIMIT 100
  `).all(projectId) as Array<{ id: string; status: string; created_at: string; updated_at: string }>;
  res.status(200).json(successResponse({ caseStudies: rows.map((row) => ({ id: row.id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at })) }, 'Case study history retrieved'));
}

export function getCaseStudyVersion(req: Request, res: Response): void {
  const userId = (req as AuthenticatedRequest).user.id;
  const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const caseStudyId = Array.isArray(req.params.caseStudyId) ? req.params.caseStudyId[0] : req.params.caseStudyId;
  const row = database.prepare(`
    SELECT c.* FROM case_studies c
    JOIN projects p ON p.id = c.project_id
    WHERE c.project_id = ? AND c.id = ? AND p.user_id = ?
  `).get(projectId, caseStudyId, userId) as unknown as { id: string; content_json: string; status: string; created_at: string; updated_at: string } | undefined;
  if (!row) throw AppError.notFound('Case study');
  res.status(200).json(successResponse({ id: row.id, status: row.status, content: JSON.parse(row.content_json), createdAt: row.created_at, updatedAt: row.updated_at }, 'Case study version retrieved'));
}
