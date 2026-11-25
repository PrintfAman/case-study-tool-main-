import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';
import { database } from '../storage/database';
import { AppError } from '../utils/app-error';
import { successResponse } from '../utils/api-response';
import { synthesizeCaseStudy } from '../services/case-study.service';
import { ensureProjectInformation, getFinalizedProjectInformation } from '../services/project-information.service';

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
    // Source crawling and field extraction happen as soon as the project is
    // created. Reuse that evidence here so the user can review/finalize fields
    // before this click creates a case-study version.
    const sourceInfo = await ensureProjectInformation(project.id, userId);
    const finalizedProjectInformation = getFinalizedProjectInformation(project.id);
    const sourceWarnings = [...sourceInfo.warnings];

    const content = await synthesizeCaseStudy({
      project: { name: project.name, websiteUrl: project.website_url, githubUrl: project.github_url },
      website: sourceInfo.evidence.website,
      github: sourceInfo.evidence.github,
      competitors: sourceInfo.evidence.competitors,
      projectInformation: finalizedProjectInformation,
    });
    if (typeof content.synthesisWarning === 'string') sourceWarnings.push(content.synthesisWarning);

    const status = sourceWarnings.length > 0 ? 'completed_with_warnings' : 'completed';
    const id = randomUUID();
    const now = new Date().toISOString();
    const persistedContent = {
      ...content,
      evidence: sourceInfo.evidence,
      finalizedProjectInformation,
      sourceWarnings,
    };
    database.exec('BEGIN IMMEDIATE');
    try {
      database.prepare(`
        INSERT INTO case_studies (id, project_id, status, content_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(id, project.id, status, JSON.stringify(persistedContent), now, now);
      database.prepare('UPDATE projects SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(status, now, project.id, userId);
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }

    res.status(200).json(successResponse({ projectId: project.id, caseStudyId: id, status, content: persistedContent }, 'Case study created from finalized project information'));
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
