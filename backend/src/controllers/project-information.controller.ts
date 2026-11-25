import type { Request, Response } from 'express';
import { z } from 'zod';
import { ensureProjectInformation } from '../services/project-information.service';
import { database } from '../storage/database';
import { successResponse } from '../utils/api-response';
import { ensureProjectExists } from '../utils/require-project';

const discoveryInputSchema = z.object({ refresh: z.boolean().optional() }).strict();

export async function discoverProjectFields(req: Request, res: Response): Promise<void> {
  const projectId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  ensureProjectExists(projectId);
  const input = discoveryInputSchema.parse(req.body ?? {});
  const result = await ensureProjectInformation(projectId, input.refresh ?? false);
  const fieldCount = (database.prepare('SELECT COUNT(*) AS count FROM project_fields WHERE project_id = ?').get(projectId) as { count: number }).count;
  res.status(200).json(successResponse({
    projectId,
    status: result.status,
    warnings: result.warnings,
    fieldCount,
    updatedAt: result.updatedAt,
  }, 'Project information is ready'));
}
