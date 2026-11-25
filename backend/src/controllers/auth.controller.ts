import { randomBytes, randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { createSession, deleteSession, getSessionUser, hashPassword, verifyPassword } from '../auth/session';
import { database } from '../storage/database';
import { AppError } from '../utils/app-error';
import { successResponse } from '../utils/api-response';
import type { AuthenticatedRequest } from '../middleware/auth.middleware';

const credentialsSchema = z.object({
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  password: z.string().min(8).max(128),
});

const registerSchema = credentialsSchema.extend({
  name: z.string().trim().min(2).max(100),
});

export function register(req: Request, res: Response): void {
  const input = registerSchema.parse(req.body);
  const existing = database.prepare('SELECT id FROM users WHERE email = ?').get(input.email);
  if (existing) {
    throw new AppError('An account with this email already exists', {
      statusCode: 409,
      code: 'CONFLICT',
      details: [{ field: 'email', message: 'Email is already registered' }],
    });
  }

  const id = randomUUID();
  const password = hashPassword(input.password);
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO users (id, email, name, password_salt, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, input.email, input.name, password.salt, password.hash, now);
  createSession(res, id);
  res.status(201).json(successResponse({ id, email: input.email, name: input.name }, 'Account created'));
}

export function login(req: Request, res: Response): void {
  const input = credentialsSchema.parse(req.body);
  const row = database.prepare(`
    SELECT id, email, name, password_salt, password_hash
    FROM users WHERE email = ?
  `).get(input.email) as { id: string; email: string; name: string; password_salt: string; password_hash: string } | undefined;

  if (!row || !verifyPassword(input.password, row.password_salt, row.password_hash)) {
    throw new AppError('Invalid email or password', {
      statusCode: 401,
      code: 'UNAUTHORIZED',
    });
  }

  createSession(res, row.id);
  res.status(200).json(successResponse({ id: row.id, email: row.email, name: row.name }, 'Signed in'));
}

/** Creates an isolated, private workspace for visitors who do not sign in. */
export function createGuestWorkspace(req: Request, res: Response): void {
  const existingUser = getSessionUser(req);
  if (existingUser) {
    res.status(200).json(successResponse(existingUser, 'Existing workspace restored'));
    return;
  }

  const id = randomUUID();
  const email = `guest-${id}@guest.case-study-tool.invalid`;
  const credentials = hashPassword(randomBytes(32).toString('base64url'));
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO users (id, email, name, password_salt, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, email, 'Guest', credentials.salt, credentials.hash, now);
  createSession(res, id);
  res.status(201).json(successResponse({ id, email, name: 'Guest' }, 'Private workspace created'));
}

export function me(req: Request, res: Response): void {
  const user = (req as AuthenticatedRequest).user;
  res.status(200).json(successResponse(user, 'Authenticated session'));
}

export function logout(req: Request, res: Response): void {
  deleteSession(req, res);
  res.status(200).json(successResponse(null, 'Signed out'));
}
