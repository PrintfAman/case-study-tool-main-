import { Router } from 'express';
import { downloadReport, generateReport } from '../controllers/reports.controller';
import { createIpRateLimiter } from '../middleware/request-rate-limit.middleware';

export const reportsRouter = Router();

reportsRouter.post('/projects/:id/report', createIpRateLimiter({ maxRequests: 30, message: 'Too many PDF report requests from this network. Try again later.' }), generateReport);
reportsRouter.get('/projects/:id/report/download/:fileName', downloadReport);
