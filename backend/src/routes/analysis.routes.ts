import { Router } from 'express';
import { getCaseStudy, getCaseStudyVersion, listCaseStudies, runAnalysis } from '../controllers/analysis.controller';
import { editCaseStudySection, listProjectChat, sendProjectChatMessage } from '../controllers/project-ai.controller';
import { createIpRateLimiter } from '../middleware/request-rate-limit.middleware';

export const analysisRouter = Router();

analysisRouter.post('/projects/:id/analyze', createIpRateLimiter({ maxRequests: 10, message: 'Too many AI case-study requests from this network. Try again later.' }), runAnalysis);
analysisRouter.get('/projects/:id/case-study', getCaseStudy);
analysisRouter.get('/projects/:id/case-studies', listCaseStudies);
analysisRouter.get('/projects/:id/case-studies/:caseStudyId', getCaseStudyVersion);
analysisRouter.get('/projects/:id/chat', listProjectChat);
analysisRouter.post('/projects/:id/chat', createIpRateLimiter({ maxRequests: 60, message: 'Too many AI chat requests from this network. Try again later.' }), sendProjectChatMessage);
analysisRouter.post('/projects/:id/case-studies/:caseStudyId/sections', createIpRateLimiter({ maxRequests: 30, message: 'Too many report editing requests from this network. Try again later.' }), editCaseStudySection);
