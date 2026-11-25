import express, { Router } from 'express';
import { bulkUpdateProjectFields, createProjectField, deleteProjectField, downloadProjectFieldAttachment, listProjectFields, reorderProjectFields, restoreAiProjectField, updateFieldSuggestion, updateProjectField, uploadProjectFieldAttachment } from '../controllers/project-fields.controller';
import { createProject, deleteProject, getProject, listProjects } from '../controllers/projects.controller';
import { discoverProjectFields } from '../controllers/project-information.controller';
import { createIpRateLimiter } from '../middleware/request-rate-limit.middleware';

export const projectsRouter = Router();

projectsRouter.post('/', createIpRateLimiter({ maxRequests: 25, message: 'Too many projects created from this network. Try again later.' }), createProject);
projectsRouter.post('/:id/discover-fields', createIpRateLimiter({ maxRequests: 20, message: 'Too many project analyses from this network. Try again later.' }), discoverProjectFields);
projectsRouter.get('/', listProjects);
projectsRouter.get('/:projectId/fields', listProjectFields);
projectsRouter.post('/:projectId/fields', createProjectField);
projectsRouter.patch('/:projectId/fields/bulk', bulkUpdateProjectFields);
projectsRouter.post('/:projectId/fields/reorder', reorderProjectFields);
projectsRouter.post('/:projectId/fields/:fieldId/suggestion', updateFieldSuggestion);
projectsRouter.post('/:projectId/fields/:fieldId/restore-ai', restoreAiProjectField);
projectsRouter.post('/:projectId/fields/:fieldId/attachment', express.raw({ type: 'application/octet-stream', limit: '10mb' }), uploadProjectFieldAttachment);
projectsRouter.get('/:projectId/fields/:fieldId/attachment/:attachmentId', downloadProjectFieldAttachment);
projectsRouter.patch('/:projectId/fields/:fieldId', updateProjectField);
projectsRouter.delete('/:projectId/fields/:fieldId', deleteProjectField);
projectsRouter.get('/:id', getProject);
projectsRouter.delete('/:id', deleteProject);
