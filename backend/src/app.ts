import cors from 'cors';
import express, { type Express } from 'express';
import { env } from './config/env';
import { getHealth } from './controllers/health.controller';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { requestLogger } from './middleware/request-logger.middleware';
import { apiRouter } from './routes';

/**
 * APP FACTORY
 * -----------
 * This file builds and wires the Express application. It deliberately does NOT
 * call app.listen() - that happens in server.ts.
 *
 * Why split them?
 *   - server.ts owns the process: ports, signals, shutdown.
 *   - app.ts owns the pipeline: middleware, routes, error handling.
 * In Phase 9 a test can import `createApp()` and fire requests at it with
 * Supertest without binding a port, so tests never fight over :5000.
 *
 * MIDDLEWARE ORDER MATTERS. Requests flow top to bottom through this list.
 *
 *   1. cors          - answer browser preflights before anything can fail
 *   2. express.json  - parse the body so controllers receive `req.body`
 *   3. requestLogger - start the timer after parsing
 *   4. routes        - the actual endpoints
 *   5. notFound      - nothing matched above
 *   6. errorHandler  - last, so it catches throws from every layer above
 */
export function createApp(): Express {
  const app = express();

  // Do not advertise the framework in the X-Powered-By header.
  app.disable('x-powered-by');

  // Render terminates TLS at its load balancer and forwards the client address
  // in X-Forwarded-For. Trust exactly that one proxy hop in production so IP
  // based protections do not treat every visitor as the same Render proxy.
  if (env.isProduction) app.set('trust proxy', 1);

  // The API serves JSON and downloads, never executable HTML. These headers
  // reduce browser attack surface without needing another runtime dependency.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (env.isProduction) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  /**
   * CORS: a browser blocks the React app (localhost:5173) from calling the API
   * (localhost:5000) unless the API explicitly allows that origin. `credentials`
   * is enabled because Phase 2 sends auth credentials cross-origin.
   */
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true,
    }),
  );

  /**
   * Parses JSON bodies into `req.body`. The size limit stops a client from
   * streaming a huge payload into memory; oversized bodies get 413 and are
   * handled by the error middleware.
   */
  app.use(express.json({ limit: '1mb' }));

  app.use(requestLogger);

  /**
   * Root-level liveness probe, kept outside /api/v1 so infrastructure (Docker,
   * uptime monitors) can hit a URL that never changes when the API version
   * does. The versioned equivalent lives at GET /api/v1/health.
   */
  app.get('/health', getHealth);

  // Every business endpoint lives under the versioned prefix.
  app.use(env.API_PREFIX, apiRouter);

  // These two must stay last.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
