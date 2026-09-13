import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from './config.ts';
import { all, get, insert, run } from './db.ts';
import { newId, randomToken, sha256 } from './ids.ts';
import { addDays, nowIso } from './time.ts';
import { unauthorized, badRequest } from './errors.ts';
import type { Role } from './permissions.ts';

export interface AuthUser {
  id: string;
  org_id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: Role;
  status: string;
  avatar_color: string;
  theme: string;
  notif_prefs: string;
  phone: string | null;
}

const PASSWORD_MIN = 10;

export function hashPassword(password: string): string {
  if (password.length < PASSWORD_MIN) {
    throw badRequest(`Password must be at least ${PASSWORD_MIN} characters.`);
  }
  return bcrypt.hashSync(password, 11);
}

export function verifyPassword(password: string, hash: string): boolean {
  try { return bcrypt.compareSync(password, hash); } catch { return false; }
}

export interface TokenPair { accessToken: string; refreshToken: string; expiresAt: string }

export function createSession(user: AuthUser, meta: { ip?: string; userAgent?: string }): TokenPair {
  const refreshToken = randomToken(32);
  const sessionId = newId('ses');
  const expiresAt = addDays(new Date(), config.sessionTtlDays);
  insert('sessions', {
    id: sessionId,
    user_id: user.id,
    org_id: user.org_id,
    token_hash: sha256(refreshToken),
    user_agent: meta.userAgent ?? null,
    ip: meta.ip ?? null,
    expires_at: expiresAt,
    created_at: nowIso(),
  });
  return { accessToken: signAccessToken(user, sessionId), refreshToken, expiresAt };
}

export function signAccessToken(user: AuthUser, sessionId: string): string {
  return jwt.sign(
    { sub: user.id, org: user.org_id, role: user.role, sid: sessionId },
    config.jwtSecret,
    { expiresIn: `${config.accessTokenTtlMin}m`, issuer: 'voltaflow' },
  );
}

export interface AccessClaims { sub: string; org: string; role: Role; sid: string }

export function verifyAccessToken(token: string): AccessClaims {
  try {
    return jwt.verify(token, config.jwtSecret, { issuer: 'voltaflow' }) as AccessClaims;
  } catch {
    throw unauthorized('Your session has expired. Please sign in again.');
  }
}

export function refreshSession(refreshToken: string): { user: AuthUser; accessToken: string } {
  const session = get<{ id: string; user_id: string; expires_at: string; revoked_at: string | null }>(
    'SELECT id, user_id, expires_at, revoked_at FROM sessions WHERE token_hash = ?',
    [sha256(refreshToken)],
  );
  if (!session || session.revoked_at || new Date(session.expires_at) < new Date()) {
    throw unauthorized('Your session has expired. Please sign in again.');
  }
  const user = get<AuthUser>('SELECT * FROM users WHERE id = ?', [session.user_id]);
  if (!user || user.status !== 'active') throw unauthorized('This account is no longer active.');
  return { user, accessToken: signAccessToken(user, session.id) };
}

export function revokeSession(refreshToken: string): void {
  run('UPDATE sessions SET revoked_at = ? WHERE token_hash = ?', [nowIso(), sha256(refreshToken)]);
}

export function revokeAllSessions(userId: string): void {
  run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), userId]);
}

export function listSessions(userId: string) {
  return all(
    `SELECT id, user_agent, ip, created_at, expires_at, revoked_at FROM sessions
     WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
    [userId, nowIso()],
  );
}
