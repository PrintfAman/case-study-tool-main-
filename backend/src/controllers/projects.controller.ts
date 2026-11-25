import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { database } from '../storage/database';
import { AppError } from '../utils/app-error';
import { successResponse } from '../utils/api-response';
import { parseGitHubUrl } from '../services/github-analyzer.service';
import { seedProjectFields } from '../services/project-fields.service';

const projectSchema = z.object({
  name: z.string().trim().min(2).max(120),
  websiteUrl: z.string().trim().url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), 'Must use HTTP or HTTPS').nullable().optional(),
  githubUrl: z.string().trim().url().refine((value) => {
    try { parseGitHubUrl(value); return true; } catch { return false; }
  }, 'GitHub repository must use https://github.com/owner/repository').nullable().optional(),
}).superRefine((value, context) => {
  if (!value.websiteUrl && !value.githubUrl) {
    context.addIssue({ code: 'custom', message: 'Provide a website URL or a GitHub repository URL', path: ['websiteUrl'] });
  }
});

interface ProjectRow {
  id: string;
  name: string;
  website_url: string | null;
  github_url: string | null;
  status: string;
  input_json: string;
  created_at: string;
  updated_at: string;
  field_discovery_status: 'running' | 'completed' | 'completed_with_warnings' | 'failed' | null;
}

function serializeProject(row: ProjectRow) {
  return {
    id: row.id,
    name: row.name,
    websiteUrl: row.website_url,
    githubUrl: row.github_url,
    status: row.status,
    input: JSON.parse(row.input_json) as unknown,
    fieldDiscoveryStatus: row.field_discovery_status ?? 'not_started',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createProject(req: Request, res: Response): Promise<void> {
  const input = projectSchema.parse(req.body);
  const id = randomUUID();
  const now = new Date().toISOString();
  const row = await database.transaction(async () => {
    await database.prepare(`
      INSERT INTO projects (id, name, website_url, github_url, status, input_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.name, input.websiteUrl ?? null, input.githubUrl ?? null, 'draft', JSON.stringify(input), now, now);
    await seedProjectFields(id, { name: input.name, websiteUrl: input.websiteUrl ?? null, githubUrl: input.githubUrl ?? null });
    return await database.prepare(`
      SELECT p.*, a.status AS field_discovery_status
      FROM projects p LEFT JOIN project_source_analyses a ON a.project_id = p.id
      WHERE p.id = ?
    `).get(id) as unknown as ProjectRow;
  });
  res.status(201).json(successResponse(serializeProject(row), 'Project created'));
}

export async function listProjects(_req: Request, res: Response): Promise<void> {
  const rows = await database.prepare(`
    SELECT p.*, a.status AS field_discovery_status
    FROM projects p LEFT JOIN project_source_analyses a ON a.project_id = p.id
    ORDER BY p.updated_at DESC
  `).all() as unknown as ProjectRow[];
  res.status(200).json(successResponse({ projects: rows.map(serializeProject) }, 'Projects retrieved'));
}

export async function getProject(req: Request, res: Response): Promise<void> {
  const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const row = await database.prepare(`
    SELECT p.*, a.status AS field_discovery_status
    FROM projects p LEFT JOIN project_source_analyses a ON a.project_id = p.id
    WHERE p.id = ?
  `).get(projectId) as unknown as ProjectRow | undefined;
  if (!row) throw AppError.notFound('Project');
  res.status(200).json(successResponse(serializeProject(row), 'Project retrieved'));
}

export async function deleteProject(req: Request, res: Response): Promise<void> {
  const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const result = await database.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
  if (result.changes === 0) throw AppError.notFound('Project');
  res.status(200).json(successResponse(null, 'Project deleted'));
}
