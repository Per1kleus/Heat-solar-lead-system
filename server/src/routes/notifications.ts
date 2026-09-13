import { Router } from 'express';
import { z } from 'zod';
import { all, get, run } from '../lib/db.ts';
import { ah } from '../middleware/errors.ts';
import { nowIso } from '../lib/time.ts';
import { defaultNotificationPrefs } from '../lib/notify.ts';

export const notificationsRouter = Router();

notificationsRouter.get('/', ah((req, res) => {
  const unreadOnly = req.query.unread === '1';
  const rows = all<any>(
    `SELECT * FROM notifications WHERE org_id = ? AND user_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''}
     ORDER BY created_at DESC LIMIT ?`,
    [req.ctx.orgId, req.ctx.user.id, Math.min(Number(req.query.limit ?? 50), 200)],
  );
  const unread = get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM notifications WHERE org_id = ? AND user_id = ? AND read_at IS NULL',
    [req.ctx.orgId, req.ctx.user.id],
  )?.n ?? 0;
  res.json({ notifications: rows, unread });
}));

notificationsRouter.post('/read', ah((req, res) => {
  const { ids } = z.object({ ids: z.array(z.string()).optional() }).parse(req.body ?? {});
  if (ids?.length) {
    run(
      `UPDATE notifications SET read_at = ? WHERE org_id = ? AND user_id = ? AND read_at IS NULL
        AND id IN (${ids.map(() => '?').join(',')})`,
      [nowIso(), req.ctx.orgId, req.ctx.user.id, ...ids],
    );
  } else {
    run('UPDATE notifications SET read_at = ? WHERE org_id = ? AND user_id = ? AND read_at IS NULL', [
      nowIso(), req.ctx.orgId, req.ctx.user.id,
    ]);
  }
  res.json({
    unread: get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM notifications WHERE org_id = ? AND user_id = ? AND read_at IS NULL',
      [req.ctx.orgId, req.ctx.user.id],
    )?.n ?? 0,
  });
}));

notificationsRouter.get('/preferences', ah((req, res) => {
  const row = get<{ notif_prefs: string }>('SELECT notif_prefs FROM users WHERE id = ?', [req.ctx.user.id]);
  let stored: Record<string, boolean> = {};
  try { stored = JSON.parse(row?.notif_prefs ?? '{}'); } catch { stored = {}; }
  res.json({
    preferences: { ...defaultNotificationPrefs, ...stored },
    descriptions: {
      lead_assigned: 'A lead is assigned to me',
      hot_lead: 'One of my leads becomes hot',
      task_overdue: 'A follow-up of mine becomes overdue',
      task_due: 'A follow-up of mine is due',
      quote_stale: 'A quotation of mine has had no response',
      quote_accepted: 'A customer accepts my quotation',
      appointment_soon: 'I have an appointment tomorrow',
      lead_idle: 'One of my leads has gone quiet',
      deal_won: 'A deal is won',
      deal_lost: 'A deal is lost',
      no_next_action: 'One of my leads has no next action',
      survey_assigned: 'A site survey is assigned to me',
      automation: 'An automation ran on one of my leads',
      limit: 'Plan limits and billing',
    },
  });
}));
