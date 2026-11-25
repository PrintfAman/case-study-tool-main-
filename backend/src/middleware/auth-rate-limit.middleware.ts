import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../utils/app-error';

const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 10;
const failedAttempts = new Map<string, number[]>();

/** Bounds repeated registration and password-guessing attempts per client IP. */
export function limitAuthAttempts(req: Request, res: Response, next: NextFunction): void {
  const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const recent = (failedAttempts.get(key) ?? []).filter((timestamp) => now - timestamp < WINDOW_MS);
  failedAttempts.set(key, recent);

  if (recent.length >= MAX_FAILED_ATTEMPTS) {
    next(new AppError('Too many authentication attempts. Try again in a few minutes.', {
      statusCode: 429,
      code: 'RATE_LIMITED',
    }));
    return;
  }

  res.once('finish', () => {
    if (res.statusCode >= 400) {
      const attempts = failedAttempts.get(key) ?? [];
      attempts.push(Date.now());
      failedAttempts.set(key, attempts);
    }
  });

  if (failedAttempts.size > 10_000) {
    for (const [address, attempts] of failedAttempts) {
      if (attempts.every((timestamp) => now - timestamp >= WINDOW_MS)) failedAttempts.delete(address);
    }
  }

  next();
}
