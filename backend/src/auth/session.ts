import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { env } from '../config/env';
import { database } from '../storage/database';

const SESSION_COOKIE = 'cst_session';

function sign(value: string): string {
  return createHmac('sha256', env.SESSION_SECRET).update(value).digest('base64url');
}

export function createSessionCookie(sessionId: string): string {
  const signed = `${sessionId}.${sign(sessionId)}`;
  const secure = env.isProduction ? '; Secure' : '';
  return `${SESSION_COOKIE}=${signed}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${env.SESSION_DAYS * 86400}${secure}`;
}

export function clearSessionCookie(): string {
  const secure = env.isProduction ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function parseCookieHeader(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) {
      result[part.slice(0, index).trim()] = part.slice(index + 1).trim();
    }
  }
  return result;
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

function getVerifiedSessionId(req: Request): string | null {
  const cookie = parseCookieHeader(req.headers.cookie)[SESSION_COOKIE];
  if (!cookie) return null;

  const separator = cookie.lastIndexOf('.');
  if (separator < 1) return null;

  const sessionId = cookie.slice(0, separator);
  const signature = cookie.slice(separator + 1);
  const expected = sign(sessionId);

  let signaturesMatch = false;
  try {
    signaturesMatch = timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    signaturesMatch = false;
  }
  return signaturesMatch ? sessionId : null;
}

export function getSessionUser(req: Request): SessionUser | null {
  const sessionId = getVerifiedSessionId(req);
  if (!sessionId) return null;

  const row = database.prepare(`
    SELECT u.id, u.email, u.name
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ? AND s.expires_at > ?
  `).get(sessionId, new Date().toISOString()) as SessionUser | undefined;

  return row ?? null;
}

export function createSession(res: Response, userId: string): void {
  const id = randomBytes(32).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + env.SESSION_DAYS * 86400 * 1000);
  database.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString());
  database.prepare(`
    INSERT INTO sessions (id, user_id, expires_at, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, userId, expires.toISOString(), now.toISOString());
  res.setHeader('Set-Cookie', createSessionCookie(id));
}

export function deleteSession(req: Request, res: Response): void {
  const sessionId = getVerifiedSessionId(req);
  if (sessionId) database.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  res.setHeader('Set-Cookie', clearSessionCookie());
}

export function hashPassword(password: string): { salt: string; hash: string } {
  const salt = randomBytes(16).toString('base64url');
  return { salt, hash: scryptSync(password, salt, 64).toString('base64url') };
}

export function verifyPassword(password: string, salt: string, hash: string): boolean {
  const candidate = scryptSync(password, salt, 64);
  const stored = Buffer.from(hash, 'base64url');
  return candidate.length === stored.length && timingSafeEqual(candidate, stored);
}

export { SESSION_COOKIE };
