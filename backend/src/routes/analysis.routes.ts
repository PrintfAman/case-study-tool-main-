import { Router } from 'express';
import { getCaseStudy, getCaseStudyVersion, listCaseStudies, runAnalysis } from '../controllers/analysis.controller';
import { editCaseStudySection, listProjectChat, sendProjectChatMessage } from '../controllers/project-ai.controller';

export const analysisRouter = Router();

analysisRouter.post('/projects/:id/analyze', runAnalysis);
analysisRouter.get('/projects/:id/case-study', getCaseStudy);
analysisRouter.get('/projects/:id/case-studies', listCaseStudies);
analysisRouter.get('/projects/:id/case-studies/:caseStudyId', getCaseStudyVersion);
analysisRouter.get('/projects/:id/chat', listProjectChat);
analysisRouter.post('/projects/:id/chat', sendProjectChatMessage);
analysisRouter.post('/projects/:id/case-studies/:caseStudyId/sections', editCaseStudySection);
