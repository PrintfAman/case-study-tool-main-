import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { AppError } from '../utils/app-error';

const WINDOW_MS = 60 * 60 * 1000;

interface RateLimitOptions {
  maxRequests: number;
  message: string;
  windowMs?: number;
}

/** Per-IP fixed-window limits for public endpoints, especially paid AI work. */
export function createIpRateLimiter(options: RateLimitOptions): RequestHandler {
  const requests = new Map<string, { count: number; expiresAt: number }>();
  const windowMs = options.windowMs ?? WINDOW_MS;

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    let bucket = requests.get(key);
    if (!bucket || bucket.expiresAt <= now) {
      bucket = { count: 0, expiresAt: now + windowMs };
      requests.set(key, bucket);
    }

    res.setHeader('RateLimit-Limit', String(options.maxRequests));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, options.maxRequests - bucket.count - 1)));
    res.setHeader('RateLimit-Reset', String(Math.ceil(bucket.expiresAt / 1000)));
    if (bucket.count >= options.maxRequests) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000))));
      next(new AppError(options.message, { statusCode: 429, code: 'RATE_LIMITED' }));
      return;
    }

    bucket.count += 1;
    if (requests.size > 10_000) {
      for (const [address, entry] of requests) {
        if (entry.expiresAt <= now) requests.delete(address);
      }
    }
    next();
  };
}
