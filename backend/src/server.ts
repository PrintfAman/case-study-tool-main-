import type { Server } from 'node:http';
import { createApp } from './app';
import { env } from './config/env';
import { closeDatabase } from './storage/database';
import { logger } from './utils/logger';

/**
 * PROCESS ENTRY POINT
 * -------------------
 * The only job of this file: start listening, say so clearly, and shut down in
 * an orderly way. All routing lives in app.ts.
 *
 * WHY GRACEFUL SHUTDOWN MATTERS (this becomes very relevant in Phase 3):
 * When you press Ctrl+C, Node would normally kill everything instantly, aborting
 * in-flight requests. Later phases run crawling and AI jobs - cutting those off
 * mid-write leaves half-finished database rows. `server.close()` stops accepting
 * new connections, lets current requests finish, then exits. The timer is a
 * safety net so a hanging request can never block a deploy forever.
 */

const SHUTDOWN_TIMEOUT_MS = 10_000;

const app = createApp();

const server: Server = app.listen(env.PORT, () => {
  logger.info('Backend server started', {
    url: `http://localhost:${env.PORT}`,
    health: `http://localhost:${env.PORT}/health`,
    apiPrefix: env.API_PREFIX,
    environment: env.NODE_ENV,
    allowedOrigin: env.CORS_ORIGIN,
  });
});

/** Port already taken is the single most common local startup failure. */
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    logger.error(`Port ${env.PORT} is already in use`, {
      hint: 'Stop the other process or set PORT to a different value in backend/.env',
    });
  } else {
    logger.error('Server failed to start', { message: error.message });
  }
  process.exit(1);
});

/** Guards against running shutdown twice (e.g. Ctrl+C pressed twice). */
let isShuttingDown = false;

function shutdown(signal: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info('Shutdown signal received, closing server', { signal });

  const forceExitTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out, forcing exit', {
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
    });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  // .unref() lets Node exit without waiting on this timer if everything else is done.
  forceExitTimer.unref();

  server.close((error) => {
    clearTimeout(forceExitTimer);

    if (error) {
      logger.error('Error while closing server', { message: error.message });
      process.exit(1);
    }

    closeDatabase();
    logger.info('Server closed cleanly');
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/**
 * A rejected promise nobody handled means a bug we did not plan for. Log it
 * loudly instead of letting Node print an unhelpful warning and carry on in an
 * unknown state.
 */
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception, shutting down', {
    message: error.message,
    stack: error.stack,
  });
  shutdown('uncaughtException');
});
