import { Router } from 'express';
import { healthRouter } from './health.routes';
import { projectsRouter } from './projects.routes';
import { analysisRouter } from './analysis.routes';
import { reportsRouter } from './reports.routes';

/**
 * THE V1 API ROOT
 * ---------------
 * Every versioned module is mounted here, in one list. app.ts mounts this router
 * once at /api/v1, so a URL like GET /api/v1/health flows:
 *
 *   app (mount /api/v1) -> apiRouter (mount /health) -> healthRouter (GET /)
 *
 * Why a separate file instead of mounting each router in app.ts?
 * Because as projects, analysis, business, competitors, case studies and
 * reports arrive, app.ts would otherwise become a long ladder of `app.use`
 * calls. Here the URL map stays in the routes folder, next to the routers.
 *
 * Adding a module later is one import + one `use` line.
 */
export const apiRouter = Router();

apiRouter.use('/health', healthRouter);
apiRouter.use('/projects', projectsRouter);
apiRouter.use('/analysis', analysisRouter);
apiRouter.use('/reports', reportsRouter);
