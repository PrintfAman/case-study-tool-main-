import type { NextFunction, Request, Response } from 'express';
import { getSessionUser } from '../auth/session';
import { AppError } from '../utils/app-error';

const WINDOW_MS = 60 * 60 * 1000;
const MAX_NEW_GUESTS = 20;
const guestCreations = new Map<string, number[]>();

/** Limits anonymous account creation while allowing an existing workspace to restore. */
export function limitGuestWorkspaceCreation(req: Request, _res: Response, next: NextFunction): void {
  if (getSessionUser(req)) {
    next();
    return;
  }

  const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const recent = (guestCreations.get(key) ?? []).filter((timestamp) => now - timestamp < WINDOW_MS);
  if (recent.length >= MAX_NEW_GUESTS) {
    next(new AppError('Too many new workspaces from this network. Try again later.', {
      statusCode: 429,
      code: 'RATE_LIMITED',
    }));
    return;
  }

  recent.push(now);
  guestCreations.set(key, recent);
  if (guestCreations.size > 10_000) {
    for (const [address, attempts] of guestCreations) {
      if (attempts.every((timestamp) => now - timestamp >= WINDOW_MS)) guestCreations.delete(address);
    }
  }
  next();
}
