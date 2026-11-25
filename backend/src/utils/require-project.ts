import { database } from '../storage/database';
import { AppError } from './app-error';

/** Validates a project ID for public, project-scoped endpoints. */
export async function ensureProjectExists(projectId: string): Promise<void> {
  if (!await database.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId)) {
    throw AppError.notFound('Project');
  }
}
