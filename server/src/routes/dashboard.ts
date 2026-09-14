import { Router } from 'express';
import { all, get } from '../lib/db.ts';
import { ah } from '../middleware/errors.ts';
import { nowIso, startOfDay, startOfWeek, startOfMonth, addDays } from '../lib/time.ts';
import { shapeLead, LEAD_SELECT } from '../lib/leads.ts';
import { buildAttentionList, summariseAttention } from '../lib/attention.ts';

export const dashboardRouter = Router();

/**
 * Everything the dashboard needs in a single round trip. Every figure is a
 * live aggregate over the organisation's own rows; a salesperson sees only
 * their own book.
 */
dashboardRouter.get('/', ah((req, res) => {
  const { orgId } = req.ctx;
  const mine = !req.ctx.seesAll();
  const userId = req.ctx.user.id;
  const ownerClause = mine ? 'AND l.owner_id = ?' : '';
  const ownerParam = mine ? [userId] : [];
  const now = nowIso();
  const today = startOfDay().toISOString();
  const weekStart = startOfWeek().toISOString();
  const monthStart = startOfMonth().toISOString();
  const staleHours = get<{ stale_lead_hours: number }>(
    'SELECT stale_lead_hours FROM organizations WHERE id = ?', [orgId],
  )?.stale_lead_hours ?? 48;

  const scalar = (sql: string, params: any[] = []): number =>
    get<{ v: number }>(sql, params)?.v ?? 0;

  const kpis = {
    new_leads_today: scalar(
      `SELECT COUNT(*) AS v FROM leads l WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.created_at >= ? ${ownerClause}`,
      [orgId, today, ...ownerParam],
    ),
    new_leads_week: scalar(
      `SELECT COUNT(*) AS v FROM leads l WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.created_at >= ? ${ownerClause}`,
      [orgId, weekStart, ...ownerParam],
    ),
    follow_ups_due_today: scalar(
      `SELECT COUNT(*) AS v FROM tasks t WHERE t.org_id = ? AND t.status = 'open'
         AND t.due_at >= ? AND t.due_at <= ? ${mine ? 'AND t.assignee_id = ?' : ''}`,
      [orgId, today, addDays(startOfDay(), 1), ...ownerParam],
    ),
    overdue_follow_ups: scalar(
      `SELECT COUNT(*) AS v FROM tasks t WHERE t.org_id = ? AND t.status = 'open' AND t.due_at < ?
         ${mine ? 'AND t.assignee_id = ?' : ''}`,
      [orgId, now, ...ownerParam],
    ),
    quotes_awaiting: scalar(
      `SELECT COUNT(*) AS v FROM quotations q WHERE q.org_id = ?
         AND q.status IN ('sent','viewed','awaiting_response') ${mine ? 'AND q.owner_id = ?' : ''}`,
      [orgId, ...ownerParam],
    ),
    quotes_awaiting_value: scalar(
      `SELECT COALESCE(SUM(q.total), 0) AS v FROM quotations q WHERE q.org_id = ?
         AND q.status IN ('sent','viewed','awaiting_response') ${mine ? 'AND q.owner_id = ?' : ''}`,
      [orgId, ...ownerParam],
    ),
    hot_leads: scalar(
      `SELECT COUNT(*) AS v FROM leads l WHERE l.org_id = ? AND l.deleted_at IS NULL
         AND l.status = 'open' AND l.temperature = 'hot' ${ownerClause}`,
      [orgId, ...ownerParam],
    ),
    won_this_month: scalar(
      `SELECT COUNT(*) AS v FROM leads l WHERE l.org_id = ? AND l.deleted_at IS NULL
         AND l.status = 'won' AND l.won_at >= ? ${ownerClause}`,
      [orgId, monthStart, ...ownerParam],
    ),
    lost_this_month: scalar(
      `SELECT COUNT(*) AS v FROM leads l WHERE l.org_id = ? AND l.deleted_at IS NULL
         AND l.status = 'lost' AND l.lost_at >= ? ${ownerClause}`,
      [orgId, monthStart, ...ownerParam],
    ),
    revenue_this_month: scalar(
      `SELECT COALESCE(SUM(l.estimated_value), 0) AS v FROM leads l WHERE l.org_id = ? AND l.deleted_at IS NULL
         AND l.status = 'won' AND l.won_at >= ? ${ownerClause}`,
      [orgId, monthStart, ...ownerParam],
    ),
    pipeline_value: scalar(
      `SELECT COALESCE(SUM(l.estimated_value), 0) AS v FROM leads l WHERE l.org_id = ? AND l.deleted_at IS NULL
         AND l.status = 'open' ${ownerClause}`,
      [orgId, ...ownerParam],
    ),
    weighted_pipeline: scalar(
      `SELECT COALESCE(SUM(l.estimated_value * l.probability / 100.0), 0) AS v FROM leads l
       WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.status = 'open' ${ownerClause}`,
      [orgId, ...ownerParam],
    ),
    open_leads: scalar(
      `SELECT COUNT(*) AS v FROM leads l WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.status = 'open' ${ownerClause}`,
      [orgId, ...ownerParam],
    ),
  };

  const decided = scalar(
    `SELECT COUNT(*) AS v FROM leads l WHERE l.org_id = ? AND l.deleted_at IS NULL
       AND l.status IN ('won','lost') AND COALESCE(l.won_at, l.lost_at) >= ? ${ownerClause}`,
    [orgId, monthStart, ...ownerParam],
  );
  const conversionRate = decided > 0 ? Math.round((kpis.won_this_month / decided) * 1000) / 10 : 0;

  // --- Needs attention: one ranked list, built from data the CRM already keeps.
  const attentionItems = buildAttentionList({ orgId, userId, seesAll: req.ctx.seesAll(), staleHours });

  const todayAgenda = all<any>(
    `SELECT a.id, a.title, a.type, a.starts_at, a.ends_at, a.location, a.lead_id, a.status,
            l.first_name, l.last_name
     FROM appointments a LEFT JOIN leads l ON l.id = a.lead_id
     WHERE a.org_id = ? AND a.status = 'scheduled' AND a.starts_at >= ? AND a.starts_at < ?
       ${mine ? 'AND (a.assignee_id = ? OR a.technician_id = ?)' : ''}
     ORDER BY a.starts_at`,
    mine
      ? [orgId, today, addDays(startOfDay(), 2), userId, userId]
      : [orgId, today, addDays(startOfDay(), 2)],
  );

  const myQueue = all<any>(
    `${LEAD_SELECT} WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.status = 'open'
       ${mine ? 'AND l.owner_id = ?' : ''}
     ORDER BY (t.due_at IS NULL), t.due_at ASC LIMIT 12`,
    mine ? [orgId, userId] : [orgId],
  ).map(shapeLead);

  const stageBreakdown = all<any>(
    `SELECT st.id, st.key, st.name, st.color, st.position, st.probability,
            COUNT(l.id) AS lead_count, COALESCE(SUM(l.estimated_value), 0) AS value
     FROM pipeline_stages st
     LEFT JOIN leads l ON l.stage_id = st.id AND l.status = 'open' AND l.deleted_at IS NULL ${mine ? 'AND l.owner_id = ?' : ''}
     WHERE st.org_id = ? AND st.is_active = 1 AND st.type = 'open'
     GROUP BY st.id ORDER BY st.position`,
    mine ? [userId, orgId] : [orgId],
  );

  res.json({
    kpis: { ...kpis, conversion_rate: conversionRate, expected_revenue: Math.round(kpis.weighted_pipeline) },
    attention: attentionItems,
    attention_counts: summariseAttention(attentionItems),
    attention_total: attentionItems.length,
    urgent_total: attentionItems.filter((i) => i.priority === 1).length,
    stale_hours: staleHours,
    today_agenda: todayAgenda,
    my_queue: myQueue,
    stage_breakdown: stageBreakdown,
    scope: mine ? 'own' : 'organization',
  });
}));
