import { Router } from 'express';
import { getCaseStudy, getCaseStudyVersion, listCaseStudies, runAnalysis } from '../controllers/analysis.controller';

export const analysisRouter = Router();

analysisRouter.post('/projects/:id/analyze', runAnalysis);
analysisRouter.get('/projects/:id/case-study', getCaseStudy);
analysisRouter.get('/projects/:id/case-studies', listCaseStudies);
analysisRouter.get('/projects/:id/case-studies/:caseStudyId', getCaseStudyVersion);
