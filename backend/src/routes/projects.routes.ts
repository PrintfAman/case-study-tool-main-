import express, { Router } from 'express';
import { bulkUpdateProjectFields, createProjectField, deleteProjectField, downloadProjectFieldAttachment, listProjectFields, reorderProjectFields, restoreAiProjectField, updateFieldSuggestion, updateProjectField, uploadProjectFieldAttachment } from '../controllers/project-fields.controller';
import { createProject, deleteProject, getProject, listProjects } from '../controllers/projects.controller';

export const projectsRouter = Router();

projectsRouter.post('/', createProject);
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
