import type { NextFunction, Request, Response } from 'express';
import { verifyAccessToken, type AuthUser } from '../lib/auth.ts';
import { get } from '../lib/db.ts';
import { forbidden, unauthorized } from '../lib/errors.ts';
import { can, seesEverything, type Permission, type Role } from '../lib/permissions.ts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: RequestContext;
    }
  }
}

export interface RequestContext {
  user: AuthUser;
  orgId: string;
  role: Role;
  sessionId: string;
  can(permission: Permission): boolean;
  /** Managers and admins see the whole org; everyone else only their own records. */
  seesAll(): boolean;
  require(permission: Permission): void;
  ip: string;
}

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return next(unauthorized());
  try {
    const claims = verifyAccessToken(token);
    const user = get<AuthUser>('SELECT * FROM users WHERE id = ? AND org_id = ?', [claims.sub, claims.org]);
    if (!user) return next(unauthorized());
    if (user.status !== 'active') return next(forbidden('This account has been disabled.'));
    req.ctx = buildContext(user, claims.sid, req.ip ?? '');
    next();
  } catch (err) {
    next(err);
  }
}

export function buildContext(user: AuthUser, sessionId: string, ip: string): RequestContext {
  return {
    user,
    orgId: user.org_id,
    role: user.role,
    sessionId,
    ip,
    can: (permission) => can(user.role, permission),
    seesAll: () => seesEverything(user.role),
    require(permission) {
      if (!can(user.role, permission)) {
        throw forbidden(`Your role (${user.role.replace('_', ' ')}) cannot perform this action.`);
      }
    },
  };
}

/** Route guard: `router.get('/x', requirePermission('leads:read:own'), handler)` */
export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const ok = permissions.some((p) => req.ctx.can(p));
    if (!ok) return next(forbidden(`Your role cannot access this (${permissions.join(' or ')}).`));
    next();
  };
}
