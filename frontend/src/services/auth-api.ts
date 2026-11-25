import type { AuthUser } from '../types/auth';
import { apiRequest } from './api-client';

export function register(input: { name: string; email: string; password: string }): Promise<AuthUser> {
  return apiRequest<AuthUser>('/auth/register', { method: 'POST', body: input });
}

export function login(input: { email: string; password: string }): Promise<AuthUser> {
  return apiRequest<AuthUser>('/auth/login', { method: 'POST', body: input });
}

export function getCurrentUser(): Promise<AuthUser> {
  return apiRequest<AuthUser>('/auth/me');
}

export function createGuestWorkspace(): Promise<AuthUser> {
  return apiRequest<AuthUser>('/auth/guest', { method: 'POST' });
}

let workspacePromise: Promise<AuthUser> | null = null;

/** Restores this browser's private workspace, creating one on first use. */
export function getOrCreateWorkspaceUser(): Promise<AuthUser> {
  if (!workspacePromise) {
    workspacePromise = getCurrentUser()
      .catch(() => createGuestWorkspace())
      .catch((error: unknown) => {
        workspacePromise = null;
        throw error;
      });
  }
  return workspacePromise;
}

export function logout(): Promise<null> {
  return apiRequest<null>('/auth/logout', { method: 'POST' });
}
