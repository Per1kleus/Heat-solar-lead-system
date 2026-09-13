import type { NextFunction, Request, Response } from 'express';
import { get, run } from '../lib/db.ts';
import { tooMany } from '../lib/errors.ts';

/**
 * Fixed-window limiter backed by SQLite so limits survive a restart and work
 * across workers sharing the database file.
 */
export function rateLimit(opts: { windowMs: number; max: number; key?: (req: Request) => string; name: string }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const identity = opts.key ? opts.key(req) : (req.ip ?? 'anon');
    const bucket = `${opts.name}:${identity}`;
    const now = Date.now();
    const windowStart = Math.floor(now / opts.windowMs) * opts.windowMs;
    const row = get<{ count: number; window_start: number }>(
      'SELECT count, window_start FROM rate_limits WHERE bucket = ?', [bucket],
    );
    if (!row || row.window_start !== windowStart) {
      run(
        `INSERT INTO rate_limits (bucket, count, window_start) VALUES (?, 1, ?)
         ON CONFLICT(bucket) DO UPDATE SET count = 1, window_start = excluded.window_start`,
        [bucket, windowStart],
      );
      res.setHeader('X-RateLimit-Remaining', String(opts.max - 1));
      return next();
    }
    if (row.count >= opts.max) {
      res.setHeader('Retry-After', String(Math.ceil((windowStart + opts.windowMs - now) / 1000)));
      return next(tooMany());
    }
    run('UPDATE rate_limits SET count = count + 1 WHERE bucket = ?', [bucket]);
    res.setHeader('X-RateLimit-Remaining', String(opts.max - row.count - 1));
    next();
  };
}
