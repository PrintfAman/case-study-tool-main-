import { Router } from 'express';
import { createGuestWorkspace, login, logout, me, register } from '../controllers/auth.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { limitAuthAttempts } from '../middleware/auth-rate-limit.middleware';
import { limitGuestWorkspaceCreation } from '../middleware/guest-session-rate-limit.middleware';

export const authRouter = Router();

authRouter.post('/register', limitAuthAttempts, register);
authRouter.post('/login', limitAuthAttempts, login);
authRouter.post('/guest', limitGuestWorkspaceCreation, createGuestWorkspace);
authRouter.post('/logout', logout);
authRouter.get('/me', requireAuth, me);
