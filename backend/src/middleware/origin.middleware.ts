import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env';
import { AppError } from '../utils/app-error';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Rejects cross-origin browser mutations that could ride an existing session. */
export function requireAllowedOrigin(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    next();
    return;
  }

  const origin = req.get('origin');
  if (origin && origin !== env.CORS_ORIGIN) {
    next(new AppError('Request origin is not allowed', { statusCode: 403, code: 'FORBIDDEN' }));
    return;
  }

  next();
}
