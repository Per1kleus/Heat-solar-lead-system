import { Router } from 'express';
import { all, get } from '../lib/db.ts';
import { ah } from '../middleware/errors.ts';
import { requirePermission } from '../middleware/context.ts';
import { startOfMonth, addDays } from '../lib/time.ts';

export const analyticsRouter = Router();

function range(req: any): { from: string; to: string } {
  const q = req.query as Record<string, string | undefined>;
  const to = q.to ?? new Date().toISOString();
  const from = q.from ?? new Date(Date.now() - 180 * 86400000).toISOString();
  return { from, to };
}

/** Sales overview: volume, conversion, cycle length, value. All computed live. */
analyticsRouter.get('/sales', requirePermission('analytics:view'), ah((req, res) => {
  const { orgId } = req.ctx;
  const { from, to } = range(req);
  const mine = !req.ctx.seesAll();
  const ownerClause = mine ? 'AND l.owner_id = ?' : '';
  const p = mine ? [req.ctx.user.id] : [];

  const totals = get<any>(
    `SELECT
       COUNT(*) AS leads,
       SUM(CASE WHEN l.first_contacted_at IS NOT NULL THEN 1 ELSE 0 END) AS contacted,
       SUM(CASE WHEN l.status = 'won' THEN 1 ELSE 0 END) AS won,
       SUM(CASE WHEN l.status = 'lost' THEN 1 ELSE 0 END) AS lost,
       SUM(CASE WHEN l.status = 'won' THEN l.estimated_value ELSE 0 END) AS revenue,
       AVG(CASE WHEN l.status = 'won' THEN l.estimated_value END) AS avg_deal_value,
       AVG(CASE WHEN l.status = 'won' AND l.won_at IS NOT NULL
            THEN (julianday(l.won_at) - julianday(l.created_at)) END) AS avg_cycle_days,
       AVG(CASE WHEN l.first_contacted_at IS NOT NULL
            THEN (julianday(l.first_contacted_at) - julianday(l.created_at)) * 24 END) AS avg_response_hours
     FROM leads l
     WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.created_at BETWEEN ? AND ? ${ownerClause}`,
    [orgId, from, to, ...p],
  );

  const qualified = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM leads l JOIN pipeline_stages st ON st.id = l.stage_id
     WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.created_at BETWEEN ? AND ? AND st.position >= 2 ${ownerClause}`,
    [orgId, from, to, ...p],
  )?.n ?? 0;

  const quoted = get<{ n: number; total: number }>(
    `SELECT COUNT(DISTINCT q.lead_id) AS n, COALESCE(SUM(q.total), 0) AS total FROM quotations q
     WHERE q.org_id = ? AND q.status != 'draft' AND q.created_at BETWEEN ? AND ?
       ${mine ? 'AND q.owner_id = ?' : ''}`,
    [orgId, from, to, ...p],
  );

  const pipeline = get<any>(
    `SELECT COALESCE(SUM(l.estimated_value), 0) AS value,
            COALESCE(SUM(l.estimated_value * l.probability / 100.0), 0) AS weighted,
            COUNT(*) AS open_count,
            AVG(l.probability) AS avg_probability
     FROM leads l WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.status = 'open' ${ownerClause}`,
    [orgId, ...p],
  );

  const monthly = all<any>(
    `SELECT strftime('%Y-%m', l.created_at) AS period,
            COUNT(*) AS leads,
            SUM(CASE WHEN l.status = 'won' THEN 1 ELSE 0 END) AS won,
            SUM(CASE WHEN l.status = 'lost' THEN 1 ELSE 0 END) AS lost,
            SUM(CASE WHEN l.status = 'won' THEN l.estimated_value ELSE 0 END) AS revenue
     FROM leads l WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.created_at BETWEEN ? AND ? ${ownerClause}
     GROUP BY period ORDER BY period`,
    [orgId, from, to, ...p],
  );

  const byStage = all<any>(
    `SELECT st.key, st.name, st.color, st.position, st.probability,
            COUNT(l.id) AS count, COALESCE(SUM(l.estimated_value), 0) AS value,
            AVG(julianday('now') - julianday(l.stage_entered_at)) AS avg_days_in_stage
     FROM pipeline_stages st
     LEFT JOIN leads l ON l.stage_id = st.id AND l.status = 'open' AND l.deleted_at IS NULL ${mine ? 'AND l.owner_id = ?' : ''}
     WHERE st.org_id = ? AND st.is_active = 1
     GROUP BY st.id ORDER BY st.position`,
    mine ? [req.ctx.user.id, orgId] : [orgId],
  );

  const byProjectType = all<any>(
    `SELECT
       CASE
         WHEN l.project_types LIKE '%"pv"%' AND l.project_types LIKE '%"battery"%' THEN 'PV + battery'
         WHEN l.project_types LIKE '%"pv"%' THEN 'Photovoltaic'
         WHEN l.project_types LIKE '%"heat_pump"%' THEN 'Heat pump'
         WHEN l.project_types LIKE '%"ev_charger"%' THEN 'EV charger'
         WHEN l.project_types LIKE '%"battery"%' THEN 'Battery'
         ELSE 'Other'
       END AS project_type,
       COUNT(*) AS leads,
       SUM(CASE WHEN l.status = 'won' THEN 1 ELSE 0 END) AS won,
       SUM(CASE WHEN l.status = 'won' THEN l.estimated_value ELSE 0 END) AS revenue,
       AVG(l.estimated_value) AS avg_value
     FROM leads l WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.created_at BETWEEN ? AND ? ${ownerClause}
     GROUP BY project_type ORDER BY leads DESC`,
    [orgId, from, to, ...p],
  );

  const lostReasons = all<any>(
    `SELECT COALESCE(lr.name, 'Not recorded') AS reason, COUNT(*) AS count,
            COALESCE(SUM(l.estimated_value), 0) AS value
     FROM leads l LEFT JOIN lost_reasons lr ON lr.id = l.lost_reason_id
     WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.status = 'lost' AND l.lost_at BETWEEN ? AND ? ${ownerClause}
     GROUP BY reason ORDER BY count DESC`,
    [orgId, from, to, ...p],
  );

  const decided = (totals?.won ?? 0) + (totals?.lost ?? 0);
  res.json({
    range: { from, to },
    funnel: {
      leads: totals?.leads ?? 0,
      contacted: totals?.contacted ?? 0,
      qualified,
      quoted: quoted?.n ?? 0,
      won: totals?.won ?? 0,
      lost: totals?.lost ?? 0,
    },
    metrics: {
      revenue: totals?.revenue ?? 0,
      avg_deal_value: Math.round(totals?.avg_deal_value ?? 0),
      avg_cycle_days: Math.round((totals?.avg_cycle_days ?? 0) * 10) / 10,
      avg_response_hours: Math.round((totals?.avg_response_hours ?? 0) * 10) / 10,
      conversion_rate: decided > 0 ? Math.round(((totals?.won ?? 0) / decided) * 1000) / 10 : 0,
      lead_to_won_rate: totals?.leads > 0 ? Math.round(((totals?.won ?? 0) / totals.leads) * 1000) / 10 : 0,
      contact_rate: totals?.leads > 0 ? Math.round(((totals?.contacted ?? 0) / totals.leads) * 1000) / 10 : 0,
      quote_value: quoted?.total ?? 0,
      pipeline_value: pipeline?.value ?? 0,
      weighted_pipeline: Math.round(pipeline?.weighted ?? 0),
      avg_probability: Math.round(pipeline?.avg_probability ?? 0),
      open_count: pipeline?.open_count ?? 0,
    },
    monthly,
    by_stage: byStage,
    by_project_type: byProjectType,
    lost_reasons: lostReasons,
  });
}));

/** Marketing attribution: which channel actually produces revenue. */
analyticsRouter.get('/sources', requirePermission('analytics:view'), ah((req, res) => {
  const { orgId } = req.ctx;
  const { from, to } = range(req);
  const rows = all<any>(
    `SELECT s.id, s.key, s.name, s.category, s.cost_per_month,
            COUNT(l.id) AS leads,
            SUM(CASE WHEN l.first_contacted_at IS NOT NULL THEN 1 ELSE 0 END) AS contacted,
            SUM(CASE WHEN st.position >= 2 THEN 1 ELSE 0 END) AS qualified,
            (SELECT COUNT(DISTINCT q.lead_id) FROM quotations q
               JOIN leads l2 ON l2.id = q.lead_id
              WHERE l2.source_id = s.id AND q.org_id = ? AND q.status != 'draft'
                AND q.created_at BETWEEN ? AND ?) AS quotes,
            SUM(CASE WHEN l.status = 'won' THEN 1 ELSE 0 END) AS won,
            SUM(CASE WHEN l.status = 'lost' THEN 1 ELSE 0 END) AS lost,
            COALESCE(SUM(CASE WHEN l.status = 'won' THEN l.estimated_value ELSE 0 END), 0) AS revenue,
            COALESCE(AVG(l.score), 0) AS avg_score
     FROM lead_sources s
     LEFT JOIN leads l ON l.source_id = s.id AND l.org_id = ? AND l.deleted_at IS NULL
          AND l.created_at BETWEEN ? AND ?
     LEFT JOIN pipeline_stages st ON st.id = l.stage_id
     WHERE s.org_id = ?
     GROUP BY s.id ORDER BY revenue DESC, leads DESC`,
    [orgId, from, to, orgId, from, to, orgId],
  );
  res.json({
    range: { from, to },
    sources: rows.map((r) => ({
      ...r,
      conversion_rate: r.leads > 0 ? Math.round((r.won / r.leads) * 1000) / 10 : 0,
      quote_rate: r.leads > 0 ? Math.round((r.quotes / r.leads) * 1000) / 10 : 0,
      revenue_per_lead: r.leads > 0 ? Math.round(r.revenue / r.leads) : 0,
      avg_score: Math.round(r.avg_score),
    })),
  });
}));

/** Per-salesperson performance. Managers and admins only. */
analyticsRouter.get('/team', requirePermission('analytics:team'), ah((req, res) => {
  const { orgId } = req.ctx;
  const { from, to } = range(req);
  const rows = all<any>(
    `SELECT u.id, u.first_name, u.last_name, u.role, u.avatar_color,
            COUNT(l.id) AS leads_assigned,
            SUM(CASE WHEN l.first_contacted_at IS NOT NULL THEN 1 ELSE 0 END) AS contacted,
            SUM(CASE WHEN l.status = 'won' THEN 1 ELSE 0 END) AS won,
            SUM(CASE WHEN l.status = 'lost' THEN 1 ELSE 0 END) AS lost,
            COALESCE(SUM(CASE WHEN l.status = 'won' THEN l.estimated_value ELSE 0 END), 0) AS revenue,
            COALESCE(SUM(CASE WHEN l.status = 'open' THEN l.estimated_value ELSE 0 END), 0) AS open_pipeline,
            AVG(CASE WHEN l.first_contacted_at IS NOT NULL
                 THEN (julianday(l.first_contacted_at) - julianday(l.created_at)) * 24 END) AS avg_response_hours,
            (SELECT COUNT(*) FROM quotations q WHERE q.owner_id = u.id AND q.status != 'draft'
               AND q.created_at BETWEEN ? AND ?) AS quotes_sent,
            (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id AND t.status = 'open'
               AND t.due_at < datetime('now')) AS overdue_tasks,
            (SELECT COUNT(*) FROM activities a WHERE a.user_id = u.id AND a.is_customer_touch = 1
               AND a.occurred_at BETWEEN ? AND ?) AS customer_touches
     FROM users u
     LEFT JOIN leads l ON l.owner_id = u.id AND l.org_id = ? AND l.deleted_at IS NULL
          AND l.created_at BETWEEN ? AND ?
     WHERE u.org_id = ? AND u.status = 'active' AND u.role != 'technician'
     GROUP BY u.id ORDER BY revenue DESC`,
    [from, to, from, to, orgId, from, to, orgId],
  );
  res.json({
    range: { from, to },
    team: rows.map((r) => ({
      ...r,
      full_name: `${r.first_name} ${r.last_name}`,
      conversion_rate: r.won + r.lost > 0 ? Math.round((r.won / (r.won + r.lost)) * 1000) / 10 : 0,
      contact_rate: r.leads_assigned > 0 ? Math.round((r.contacted / r.leads_assigned) * 1000) / 10 : 0,
      avg_response_hours: Math.round((r.avg_response_hours ?? 0) * 10) / 10,
    })),
  });
}));

/** Revenue forecast from the weighted pipeline plus expected close dates. */
analyticsRouter.get('/forecast', requirePermission('analytics:revenue', 'analytics:view'), ah((req, res) => {
  const { orgId } = req.ctx;
  const mine = !req.ctx.seesAll();
  const ownerClause = mine ? 'AND l.owner_id = ?' : '';
  const p = mine ? [req.ctx.user.id] : [];

  const byStage = all<any>(
    `SELECT st.key, st.name, st.color, st.probability, COUNT(l.id) AS count,
            COALESCE(SUM(l.estimated_value), 0) AS value,
            COALESCE(SUM(l.estimated_value * l.probability / 100.0), 0) AS weighted
     FROM pipeline_stages st
     LEFT JOIN leads l ON l.stage_id = st.id AND l.status = 'open' AND l.deleted_at IS NULL ${ownerClause}
     WHERE st.org_id = ? AND st.is_active = 1 AND st.type = 'open'
     GROUP BY st.id ORDER BY st.position`,
    [...p, orgId],
  );

  const byMonth = all<any>(
    `SELECT COALESCE(strftime('%Y-%m', l.expected_close_date), 'unscheduled') AS period,
            COUNT(*) AS count,
            COALESCE(SUM(l.estimated_value), 0) AS value,
            COALESCE(SUM(l.estimated_value * l.probability / 100.0), 0) AS weighted
     FROM leads l WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.status = 'open' ${ownerClause}
     GROUP BY period ORDER BY period`,
    [orgId, ...p],
  );

  const wonThisMonth = get<{ v: number }>(
    `SELECT COALESCE(SUM(l.estimated_value), 0) AS v FROM leads l
     WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.status = 'won' AND l.won_at >= ? ${ownerClause}`,
    [orgId, startOfMonth().toISOString(), ...p],
  )?.v ?? 0;

  const quotesOut = get<any>(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS value FROM quotations
     WHERE org_id = ? AND status IN ('sent','viewed','awaiting_response') ${mine ? 'AND owner_id = ?' : ''}`,
    [orgId, ...p],
  );

  const pipelineValue = byStage.reduce((s, r) => s + r.value, 0);
  const weighted = byStage.reduce((s, r) => s + r.weighted, 0);
  res.json({
    pipeline_value: pipelineValue,
    weighted_pipeline: Math.round(weighted),
    avg_probability: pipelineValue > 0 ? Math.round((weighted / pipelineValue) * 100) : 0,
    won_this_month: wonThisMonth,
    quotes_outstanding: quotesOut,
    by_stage: byStage,
    by_month: byMonth,
  });
}));

/** Lost-lead recovery dashboard. */
analyticsRouter.get('/recovery', requirePermission('analytics:view'), ah((req, res) => {
  const { orgId } = req.ctx;
  const mine = !req.ctx.seesAll();
  const ownerClause = mine ? 'AND l.owner_id = ?' : '';
  const p = mine ? [req.ctx.user.id] : [];

  const leads = all<any>(
    `SELECT l.id, l.reference, l.first_name, l.last_name, l.estimated_value, l.lost_at, l.recovery_date,
            l.lost_notes, l.project_types, l.city, lr.name AS reason, lr.recoverable,
            u.first_name AS owner_first_name, u.last_name AS owner_last_name
     FROM leads l
     LEFT JOIN lost_reasons lr ON lr.id = l.lost_reason_id
     LEFT JOIN users u ON u.id = l.owner_id
     WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.status = 'lost' ${ownerClause}
     ORDER BY (l.recovery_date IS NULL), l.recovery_date ASC, l.estimated_value DESC LIMIT 300`,
    [orgId, ...p],
  );
  const now = new Date();
  const soon = new Date(addDays(now, 30));
  res.json({
    total_lost_value: leads.reduce((s, l) => s + Number(l.estimated_value || 0), 0),
    due_now: leads.filter((l) => l.recovery_date && new Date(l.recovery_date) <= now),
    due_soon: leads.filter((l) => l.recovery_date && new Date(l.recovery_date) > now && new Date(l.recovery_date) <= soon),
    scheduled: leads.filter((l) => l.recovery_date && new Date(l.recovery_date) > soon),
    no_recovery_date: leads.filter((l) => !l.recovery_date && l.recoverable),
    recovered: get<{ n: number; v: number }>(
      `SELECT COUNT(*) AS n, COALESCE(SUM(estimated_value), 0) AS v FROM leads
       WHERE org_id = ? AND recovered_at IS NOT NULL AND deleted_at IS NULL`,
      [orgId],
    ),
    by_reason: all(
      `SELECT COALESCE(lr.name, 'Not recorded') AS reason, COUNT(*) AS count,
              COALESCE(SUM(l.estimated_value), 0) AS value
       FROM leads l LEFT JOIN lost_reasons lr ON lr.id = l.lost_reason_id
       WHERE l.org_id = ? AND l.status = 'lost' AND l.deleted_at IS NULL ${ownerClause}
       GROUP BY reason ORDER BY value DESC`,
      [orgId, ...p],
    ),
  });
}));
