import { Router } from 'express';
import { z } from 'zod';
import {
  createSession, hashPassword, listSessions, refreshSession, revokeAllSessions, revokeSession, verifyPassword,
  type AuthUser,
} from '../lib/auth.ts';
import { get, run } from '../lib/db.ts';
import { provisionOrganization } from '../lib/provision.ts';
import { badRequest, unauthorized } from '../lib/errors.ts';
import { ah } from '../middleware/errors.ts';
import { authenticate } from '../middleware/context.ts';
import { rateLimit } from '../middleware/rateLimit.ts';
import { audit } from '../lib/audit.ts';
import { nowIso, addMinutes } from '../lib/time.ts';
import { randomToken, sha256 } from '../lib/ids.ts';
import { ROLE_PERMISSIONS } from '../lib/permissions.ts';
import { config } from '../lib/config.ts';

export const authRouter = Router();

const REFRESH_COOKIE = 'vf_refresh';
const cookieOptions = {
  httpOnly: true as const,
  sameSite: 'lax' as const,
  secure: config.env === 'production',
  path: '/api/auth',
  maxAge: config.sessionTtlDays * 24 * 60 * 60 * 1000,
};

const signupSchema = z.object({
  companyName: z.string().min(2, 'Enter your company name.'),
  firstName: z.string().min(1, 'Enter your first name.'),
  lastName: z.string().min(1, 'Enter your last name.'),
  email: z.string().email('Enter a valid email address.'),
  password: z.string().min(10, 'Use at least 10 characters.'),
  phone: z.string().optional(),
  services: z.array(z.string()).optional(),
});

authRouter.post(
  '/signup',
  rateLimit({ name: 'signup', windowMs: 60 * 60 * 1000, max: 10 }),
  ah((req, res) => {
    const input = signupSchema.parse(req.body);
    const { orgId, userId } = provisionOrganization(input);
    const user = get<AuthUser>('SELECT * FROM users WHERE id = ?', [userId])!;
    const tokens = createSession(user, { ip: req.ip, userAgent: req.headers['user-agent'] });
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, cookieOptions);
    run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), userId]);
    res.status(201).json({ accessToken: tokens.accessToken, user: shapeUser(user), orgId });
  }),
);

authRouter.post(
  '/login',
  rateLimit({ name: 'login', windowMs: 15 * 60 * 1000, max: 20, key: (req) => `${req.ip}:${String(req.body?.email ?? '')}` }),
  ah((req, res) => {
    const { email, password } = z.object({
      email: z.string().email('Enter a valid email address.'),
      password: z.string().min(1, 'Enter your password.'),
    }).parse(req.body);

    const user = get<AuthUser & { password_hash: string }>('SELECT * FROM users WHERE email = ?', [
      email.trim().toLowerCase(),
    ]);
    // Same message either way so the endpoint cannot be used to enumerate accounts.
    if (!user || !verifyPassword(password, user.password_hash)) {
      throw unauthorized('That email and password combination is not correct.');
    }
    if (user.status !== 'active') throw unauthorized('This account has been disabled. Ask your administrator.');

    const tokens = createSession(user, { ip: req.ip, userAgent: req.headers['user-agent'] });
    run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), user.id]);
    res.cookie(REFRESH_COOKIE, tokens.refreshToken, cookieOptions);
    audit({ orgId: user.org_id, userId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, ip: req.ip });
    res.json({ accessToken: tokens.accessToken, user: shapeUser(user) });
  }),
);

authRouter.post('/refresh', ah((req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] ?? req.body?.refreshToken;
  if (!token) throw unauthorized('No active session.');
  const { user, accessToken } = refreshSession(token);
  res.json({ accessToken, user: shapeUser(user) });
}));

authRouter.post('/logout', ah((req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (token) revokeSession(token);
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions, maxAge: undefined });
  res.json({ ok: true });
}));

authRouter.post(
  '/forgot-password',
  rateLimit({ name: 'forgot', windowMs: 60 * 60 * 1000, max: 10 }),
  ah((req, res) => {
    const { email } = z.object({ email: z.string().email() }).parse(req.body);
    const user = get<{ id: string; org_id: string }>('SELECT id, org_id FROM users WHERE email = ?', [
      email.trim().toLowerCase(),
    ]);
    let devToken: string | undefined;
    if (user) {
      const token = randomToken(24);
      run('UPDATE users SET reset_token = ?, reset_expires_at = ? WHERE id = ?', [
        sha256(token), addMinutes(new Date(), 60), user.id,
      ]);
      audit({ orgId: user.org_id, userId: user.id, action: 'auth.reset_requested', entityType: 'user', entityId: user.id });
      // Email delivery depends on the org's mailbox being connected; the token is
      // surfaced in development so password reset is testable without SMTP.
      if (config.env !== 'production') devToken = token;
    }
    res.json({
      ok: true,
      message: 'If that email address has an account, a reset link has been created.',
      devToken,
    });
  }),
);

authRouter.post('/reset-password', ah((req, res) => {
  const { token, password } = z.object({
    token: z.string().min(10),
    password: z.string().min(10, 'Use at least 10 characters.'),
  }).parse(req.body);
  const user = get<{ id: string; org_id: string; reset_expires_at: string }>(
    'SELECT id, org_id, reset_expires_at FROM users WHERE reset_token = ?', [sha256(token)],
  );
  if (!user || new Date(user.reset_expires_at) < new Date()) {
    throw badRequest('That reset link has expired. Request a new one.');
  }
  run('UPDATE users SET password_hash = ?, reset_token = NULL, reset_expires_at = NULL, updated_at = ? WHERE id = ?', [
    hashPassword(password), nowIso(), user.id,
  ]);
  revokeAllSessions(user.id);
  audit({ orgId: user.org_id, userId: user.id, action: 'auth.password_reset', entityType: 'user', entityId: user.id });
  res.json({ ok: true, message: 'Password updated. Sign in with your new password.' });
}));

authRouter.post('/accept-invite', ah((req, res) => {
  const { token, password } = z.object({
    token: z.string().min(10),
    password: z.string().min(10, 'Use at least 10 characters.'),
  }).parse(req.body);
  const user = get<AuthUser & { invite_token: string }>('SELECT * FROM users WHERE invite_token = ?', [sha256(token)]);
  if (!user) throw badRequest('That invitation is no longer valid. Ask your administrator to resend it.');
  run("UPDATE users SET password_hash = ?, status = 'active', invite_token = NULL, updated_at = ? WHERE id = ?", [
    hashPassword(password), nowIso(), user.id,
  ]);
  const fresh = get<AuthUser>('SELECT * FROM users WHERE id = ?', [user.id])!;
  const tokens = createSession(fresh, { ip: req.ip, userAgent: req.headers['user-agent'] });
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, cookieOptions);
  res.json({ accessToken: tokens.accessToken, user: shapeUser(fresh) });
}));

authRouter.get('/sessions', authenticate, ah((req, res) => {
  res.json({ sessions: listSessions(req.ctx.user.id) });
}));

authRouter.post('/change-password', authenticate, ah((req, res) => {
  const { currentPassword, newPassword } = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(10, 'Use at least 10 characters.'),
  }).parse(req.body);
  const row = get<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [req.ctx.user.id])!;
  if (!verifyPassword(currentPassword, row.password_hash)) throw badRequest('Your current password is not correct.');
  run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
    hashPassword(newPassword), nowIso(), req.ctx.user.id,
  ]);
  audit({
    orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'auth.password_changed',
    entityType: 'user', entityId: req.ctx.user.id,
  });
  res.json({ ok: true });
}));

export function shapeUser(user: AuthUser) {
  return {
    id: user.id,
    org_id: user.org_id,
    email: user.email,
    first_name: user.first_name,
    last_name: user.last_name,
    full_name: `${user.first_name} ${user.last_name}`,
    role: user.role,
    avatar_color: user.avatar_color,
    theme: user.theme,
    phone: user.phone,
    permissions: ROLE_PERMISSIONS[user.role] ?? [],
  };
}
