import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { database } from '../storage/database';
import { AppError } from '../utils/app-error';
import { successResponse } from '../utils/api-response';
import { env } from '../config/env';
import { createPdfReport } from '../services/pdf-report.service';
import { ensureProjectExists } from '../utils/require-project';

export async function generateReport(req: Request, res: Response): Promise<void> {
  const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const input = z.object({ caseStudyId: z.string().uuid().optional() }).strict().parse(req.body ?? {});
  const project = database.prepare('SELECT id, name FROM projects WHERE id = ?').get(projectId) as { id: string; name: string } | undefined;
  if (!project) throw AppError.notFound('Project');
  const caseStudy = input.caseStudyId
    ? database.prepare('SELECT content_json FROM case_studies WHERE project_id = ? AND id = ?').get(project.id, input.caseStudyId) as { content_json: string } | undefined
    : database.prepare('SELECT content_json FROM case_studies WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').get(project.id) as { content_json: string } | undefined;
  if (input.caseStudyId && !caseStudy) throw AppError.notFound('Case study');
  if (!caseStudy) throw new AppError('Generate the case study before creating a PDF', { statusCode: 409, code: 'CONFLICT' });

  const content = JSON.parse(caseStudy.content_json) as Record<string, unknown>;
  const report = await createPdfReport(project.id, project.name, content);
  res.status(201).json(successResponse({ fileName: report.fileName, downloadUrl: `/api/v1/reports/projects/${project.id}/report/download/${report.fileName}` }, 'PDF report generated'));
}

export function downloadReport(req: Request, res: Response): void {
  const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const fileName = Array.isArray(req.params.fileName) ? req.params.fileName[0] : req.params.fileName;
  if (!/^[a-z0-9-]+\.pdf$/i.test(fileName)) throw new AppError('Invalid report file name', { statusCode: 400, code: 'BAD_REQUEST' });

  ensureProjectExists(projectId);
  if (!fileName.startsWith(`${projectId}-`)) throw AppError.notFound('Report');

  const fullPath = resolve(process.cwd(), env.REPORT_STORAGE_DIR, fileName);
  try {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(readFileSync(fullPath));
  } catch {
    throw AppError.notFound('Report');
  }
}
