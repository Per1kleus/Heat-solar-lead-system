import { Router } from 'express';
import { z } from 'zod';
import { all, get, insert, parseJson, run } from '../lib/db.ts';
import { ah } from '../middleware/errors.ts';
import { requirePermission } from '../middleware/context.ts';
import {
  LEAD_SELECT, assignLead, createLead, findDuplicates, loadLead, logActivity, markLost, markWon,
  moveStage, pickLeadColumns, recomputeNextAction, reopenLead, rescoreLead, shapeLead, dedupeKeyFor,
  countCompleteness, listLeadTags, ensureCustomerForLead,
} from '../lib/leads.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { audit, diff } from '../lib/audit.ts';
import { nowIso } from '../lib/time.ts';
import { newId } from '../lib/ids.ts';
import { assertLeadAllowance } from '../lib/billing.ts';
import { readIdempotent, writeIdempotent } from '../lib/idempotency.ts';
import { emit } from '../lib/events.ts';

export const leadsRouter = Router();

// --- list / search --------------------------------------------------------

const SORTABLE: Record<string, string> = {
  created_at: 'l.created_at',
  updated_at: 'l.updated_at',
  last_activity_at: 'l.last_activity_at',
  estimated_value: 'l.estimated_value',
  score: 'l.score',
  name: 'l.last_name',
  next_action: 't.due_at',
};

leadsRouter.get('/', requirePermission('leads:read:own', 'leads:read:all'), ah((req, res) => {
  const { orgId } = req.ctx;
  const q = req.query as Record<string, string | undefined>;
  const where: string[] = ['l.org_id = ?', 'l.deleted_at IS NULL'];
  const params: any[] = [orgId];

  // A salesperson or technician only ever sees their own leads.
  if (!req.ctx.seesAll()) {
    where.push('l.owner_id = ?');
    params.push(req.ctx.user.id);
  } else if (q.owner_id) {
    if (q.owner_id === 'unassigned') where.push('l.owner_id IS NULL');
    else { where.push('l.owner_id = ?'); params.push(q.owner_id); }
  }

  if (q.status) { where.push(`l.status IN (${splitIn(q.status).map(() => '?').join(',')})`); params.push(...splitIn(q.status)); }
  if (q.stage_id) { where.push(`l.stage_id IN (${splitIn(q.stage_id).map(() => '?').join(',')})`); params.push(...splitIn(q.stage_id)); }
  if (q.source_id) { where.push(`l.source_id IN (${splitIn(q.source_id).map(() => '?').join(',')})`); params.push(...splitIn(q.source_id)); }
  if (q.temperature) { where.push(`l.temperature IN (${splitIn(q.temperature).map(() => '?').join(',')})`); params.push(...splitIn(q.temperature)); }
  if (q.project_type) { where.push('l.project_types LIKE ?'); params.push(`%"${q.project_type}"%`); }
  if (q.city) { where.push('lower(l.city) = ?'); params.push(q.city.toLowerCase()); }
  if (q.min_value) { where.push('l.estimated_value >= ?'); params.push(Number(q.min_value)); }
  if (q.max_value) { where.push('l.estimated_value <= ?'); params.push(Number(q.max_value)); }
  if (q.min_score) { where.push('l.score >= ?'); params.push(Number(q.min_score)); }
  if (q.created_from) { where.push('l.created_at >= ?'); params.push(q.created_from); }
  if (q.created_to) { where.push('l.created_at <= ?'); params.push(q.created_to); }
  if (q.campaign) { where.push('l.campaign = ?'); params.push(q.campaign); }
  if (q.tag_id) {
    where.push('EXISTS (SELECT 1 FROM lead_tags lt WHERE lt.lead_id = l.id AND lt.tag_id = ?)');
    params.push(q.tag_id);
  }
  if (q.flag === 'no_next_action') where.push("l.status = 'open' AND l.next_action_id IS NULL");
  if (q.flag === 'overdue') {
    where.push("EXISTS (SELECT 1 FROM tasks tk WHERE tk.lead_id = l.id AND tk.status = 'open' AND tk.due_at < ?)");
    params.push(nowIso());
  }
  if (q.flag === 'recovery') where.push("l.status = 'lost' AND l.recovery_date IS NOT NULL");
  if (q.search) {
    const term = `%${q.search.trim().toLowerCase()}%`;
    where.push(`(lower(l.first_name) LIKE ? OR lower(l.last_name) LIKE ? OR lower(l.email) LIKE ?
                 OR l.phone LIKE ? OR lower(l.company) LIKE ? OR lower(l.city) LIKE ? OR lower(l.reference) LIKE ?)`);
    params.push(term, term, term, term, term, term, term);
  }

  const clause = where.join(' AND ');
  const sort = SORTABLE[q.sort ?? 'created_at'] ?? SORTABLE.created_at;
  const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
  const limit = Math.min(Number(q.limit ?? 50), 200);
  const offset = Math.max(Number(q.offset ?? 0), 0);

  const rows = all<any>(
    `${LEAD_SELECT} WHERE ${clause} ORDER BY ${sort} ${dir} NULLS LAST LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const total = get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM leads l LEFT JOIN tasks t ON t.id = l.next_action_id WHERE ${clause}`, params,
  )?.n ?? 0;
  const value = get<{ sum: number }>(
    `SELECT COALESCE(SUM(l.estimated_value), 0) AS sum FROM leads l LEFT JOIN tasks t ON t.id = l.next_action_id WHERE ${clause}`,
    params,
  )?.sum ?? 0;

  res.json({ leads: rows.map(shapeLead), total, total_value: value, limit, offset });
}));

function splitIn(value: string): string[] {
  return value.split(',').map((v) => v.trim()).filter(Boolean);
}

// --- duplicates -----------------------------------------------------------

leadsRouter.get('/duplicates', requirePermission('leads:read:own'), ah((req, res) => {
  const { phone, email } = req.query as Record<string, string | undefined>;
  res.json({ duplicates: findDuplicates(req.ctx.orgId, phone, email) });
}));

// --- create ---------------------------------------------------------------

const leadBodySchema = z.object({
  first_name: z.string().min(1, 'Enter the customer first name.'),
  last_name: z.string().default(''),
  company: z.string().nullish(),
  phone: z.string().nullish(),
  email: z.string().email('Enter a valid email address.').nullish().or(z.literal('')),
  address: z.string().nullish(),
  city: z.string().nullish(),
  postal_code: z.string().nullish(),
  region: z.string().nullish(),
  preferred_contact: z.enum(['phone', 'email', 'whatsapp', 'sms']).nullish(),
  notes: z.string().nullish(),
  source_key: z.string().nullish(),
  campaign: z.string().nullish(),
  owner_id: z.string().nullish(),
  project_types: z.array(z.string()).default([]),
  estimated_value: z.number().nonnegative().nullish(),
  expected_close_date: z.string().nullish(),
  urgency: z.enum(['immediate', '1_3_months', '3_6_months', 'later', 'unknown']).nullish(),
  budget_known: z.boolean().nullish(),
  requested_quote: z.boolean().nullish(),
  budget_amount: z.number().nullish(),
  consent_marketing: z.boolean().nullish(),
  tags: z.array(z.string()).nullish(),
  custom_data: z.record(z.any()).nullish(),
  allow_duplicate: z.boolean().optional(),
}).passthrough();

leadsRouter.post('/', requirePermission('leads:write'), ah((req, res) => {
  const { orgId } = req.ctx;
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  const cached = readIdempotent<any>(orgId, idempotencyKey);
  if (cached) return res.status(201).json(cached);

  assertLeadAllowance(orgId);
  const body = leadBodySchema.parse(req.body);
  if (body.owner_id && !req.ctx.can('leads:assign') && body.owner_id !== req.ctx.user.id) {
    throw forbidden('Only a sales manager can assign leads to someone else.');
  }

  const { lead } = createLead(
    { ...body, email: body.email || null },
    {
      orgId,
      userId: req.ctx.user.id,
      channel: 'manual',
      sourceKey: body.source_key ?? 'manual',
      allowDuplicate: body.allow_duplicate === true,
      assignTo: body.owner_id !== undefined ? body.owner_id : undefined,
      ip: req.ip,
    },
  );
  if (body.tags?.length) applyTags(orgId, lead.id, body.tags);

  const payload = { lead: shapeLead(loadLead(orgId, lead.id)) };
  writeIdempotent(orgId, idempotencyKey, 'POST /leads', payload);
  res.status(201).json(payload);
}));

// --- read / update --------------------------------------------------------

leadsRouter.get('/:id', requirePermission('leads:read:own', 'leads:read:all'), ah((req, res) => {
  const lead = loadLead(req.ctx.orgId, req.params.id);
  assertVisible(req, lead);
  const shaped = shapeLead(lead);
  const completeness = countCompleteness(lead);
  res.json({
    lead: shaped,
    completeness,
    quotations: all(
      `SELECT id, number, title, status, total, currency, sent_at, valid_until, responded_at, created_at
       FROM quotations WHERE org_id = ? AND lead_id = ? ORDER BY created_at DESC`,
      [req.ctx.orgId, lead.id],
    ),
    tasks: all(
      `SELECT t.*, u.first_name AS assignee_first_name, u.last_name AS assignee_last_name
       FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
       WHERE t.org_id = ? AND t.lead_id = ? ORDER BY (t.status != 'open'), (t.due_at IS NULL), t.due_at`,
      [req.ctx.orgId, lead.id],
    ),
    appointments: all(
      `SELECT a.*, u.first_name AS tech_first_name, u.last_name AS tech_last_name
       FROM appointments a LEFT JOIN users u ON u.id = COALESCE(a.technician_id, a.assignee_id)
       WHERE a.org_id = ? AND a.lead_id = ? ORDER BY a.starts_at DESC`,
      [req.ctx.orgId, lead.id],
    ),
    surveys: all(
      `SELECT s.*, u.first_name AS tech_first_name, u.last_name AS tech_last_name
       FROM site_surveys s LEFT JOIN users u ON u.id = s.technician_id
       WHERE s.org_id = ? AND s.lead_id = ? ORDER BY s.created_at DESC`,
      [req.ctx.orgId, lead.id],
    ).map((s: any) => ({ ...s, findings: parseJson(s.findings, {}) })),
    documents: all(
      'SELECT * FROM documents WHERE org_id = ? AND lead_id = ? ORDER BY created_at DESC', [req.ctx.orgId, lead.id],
    ),
    automation_runs: all(
      `SELECT r.id, r.status, r.step_index, r.next_run_at, r.stopped_reason, r.started_at, r.log,
              ar.name AS rule_name, ar.trigger_type
       FROM automation_runs r JOIN automation_rules ar ON ar.id = r.rule_id
       WHERE r.org_id = ? AND r.lead_id = ? ORDER BY r.started_at DESC`,
      [req.ctx.orgId, lead.id],
    ).map((r: any) => ({ ...r, log: parseJson(r.log, []) })),
  });
}));

leadsRouter.get('/:id/activities', requirePermission('leads:read:own', 'leads:read:all'), ah((req, res) => {
  const lead = loadLead(req.ctx.orgId, req.params.id);
  assertVisible(req, lead);
  const limit = Math.min(Number(req.query.limit ?? 100), 300);
  const offset = Math.max(Number(req.query.offset ?? 0), 0);
  const rows = all<any>(
    `SELECT a.*, u.first_name, u.last_name, u.avatar_color FROM activities a
     LEFT JOIN users u ON u.id = a.user_id
     WHERE a.org_id = ? AND a.lead_id = ? ORDER BY a.occurred_at DESC LIMIT ? OFFSET ?`,
    [req.ctx.orgId, req.params.id, limit, offset],
  );
  res.json({
    activities: rows.map((r) => ({
      ...r,
      meta: parseJson(r.meta, {}),
      user_name: r.first_name ? `${r.first_name} ${r.last_name}` : null,
    })),
    total: get<{ n: number }>('SELECT COUNT(*) AS n FROM activities WHERE org_id = ? AND lead_id = ?', [
      req.ctx.orgId, req.params.id,
    ])?.n ?? 0,
  });
}));

leadsRouter.patch('/:id', requirePermission('leads:write'), ah((req, res) => {
  const { orgId } = req.ctx;
  const lead = loadLead(orgId, req.params.id);
  assertVisible(req, lead);

  const body = leadBodySchema.partial().parse(req.body);
  const columns = pickLeadColumns(body);
  if (body.project_types) {
    columns.project_types = JSON.stringify(body.project_types);
    columns.pv_interest = body.project_types.includes('pv') ? 1 : 0;
    columns.hp_interest = body.project_types.includes('heat_pump') ? 1 : 0;
    columns.battery_interest = body.project_types.includes('battery') ? 1 : 0;
    columns.ev_charger_interest = body.project_types.includes('ev_charger') ? 1 : 0;
  }
  if (body.custom_data) columns.custom_data = JSON.stringify(body.custom_data);
  if (body.source_key !== undefined) {
    const source = get<{ id: string }>('SELECT id FROM lead_sources WHERE org_id = ? AND key = ?', [orgId, body.source_key]);
    columns.source_id = source?.id ?? null;
  }
  if (body.phone !== undefined || body.email !== undefined) {
    columns.dedupe_key = dedupeKeyFor(body.phone ?? lead.phone, body.email ?? lead.email);
  }
  if (Object.keys(columns).length === 0) return res.json({ lead: shapeLead(lead) });

  columns.updated_at = nowIso();
  const keys = Object.keys(columns);
  run(
    `UPDATE leads SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND org_id = ?`,
    [...keys.map((k) => columns[k]), lead.id, orgId],
  );

  const changes = diff(lead, columns);
  if (Object.keys(changes).length > 0) {
    audit({
      orgId, userId: req.ctx.user.id, action: 'lead.updated', entityType: 'lead', entityId: lead.id,
      entityLabel: `${lead.first_name} ${lead.last_name}`, changes,
    });
    logActivity({
      orgId, leadId: lead.id, type: 'system',
      title: `Lead details updated (${Object.keys(changes).filter((k) => k !== 'updated_at').length} field(s))`,
      meta: { changes }, userId: req.ctx.user.id,
    });
  }
  if (body.tags) applyTags(orgId, lead.id, body.tags);
  rescoreLead(orgId, lead.id);
  res.json({ lead: shapeLead(loadLead(orgId, lead.id)) });
}));

leadsRouter.delete('/:id', requirePermission('leads:delete'), ah((req, res) => {
  const lead = loadLead(req.ctx.orgId, req.params.id);
  run('UPDATE leads SET deleted_at = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
    nowIso(), nowIso(), lead.id, req.ctx.orgId,
  ]);
  run("UPDATE automation_runs SET status = 'stopped', stopped_reason = 'lead_deleted' WHERE org_id = ? AND lead_id = ? AND status = 'active'", [
    req.ctx.orgId, lead.id,
  ]);
  audit({
    orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'lead.deleted', entityType: 'lead', entityId: lead.id,
    entityLabel: `${lead.first_name} ${lead.last_name}`,
  });
  res.json({ ok: true });
}));

// --- actions --------------------------------------------------------------

leadsRouter.post('/:id/stage', requirePermission('leads:write'), ah((req, res) => {
  const { stage_id } = z.object({ stage_id: z.string() }).parse(req.body);
  const lead = loadLead(req.ctx.orgId, req.params.id);
  assertVisible(req, lead);
  res.json({ lead: moveStage(req.ctx.orgId, lead.id, stage_id, req.ctx.user.id) });
}));

leadsRouter.post('/:id/assign', requirePermission('leads:assign', 'leads:write'), ah((req, res) => {
  const { owner_id } = z.object({ owner_id: z.string().nullable() }).parse(req.body);
  if (!req.ctx.can('leads:assign') && owner_id !== req.ctx.user.id) {
    throw forbidden('Only a sales manager can reassign leads to someone else.');
  }
  res.json({ lead: assignLead(req.ctx.orgId, req.params.id, owner_id, req.ctx.user.id) });
}));

leadsRouter.post('/:id/won', requirePermission('leads:write'), ah((req, res) => {
  const { contract_value } = z.object({ contract_value: z.number().nonnegative().optional() }).parse(req.body ?? {});
  const lead = loadLead(req.ctx.orgId, req.params.id);
  assertVisible(req, lead);
  res.json({ lead: markWon(req.ctx.orgId, lead.id, req.ctx.user.id, contract_value) });
}));

leadsRouter.post('/:id/lost', requirePermission('leads:write'), ah((req, res) => {
  const body = z.object({
    lost_reason_id: z.string().min(1, 'Choose why the lead was lost.'),
    lost_notes: z.string().nullish(),
    recovery_date: z.string().nullish(),
  }).parse(req.body);
  const lead = loadLead(req.ctx.orgId, req.params.id);
  assertVisible(req, lead);
  res.json({ lead: markLost(req.ctx.orgId, lead.id, req.ctx.user.id, body) });
}));

leadsRouter.post('/:id/reopen', requirePermission('leads:write'), ah((req, res) => {
  const lead = loadLead(req.ctx.orgId, req.params.id);
  assertVisible(req, lead);
  res.json({ lead: reopenLead(req.ctx.orgId, lead.id, req.ctx.user.id) });
}));

leadsRouter.post('/:id/rescore', requirePermission('leads:write'), ah((req, res) => {
  const lead = loadLead(req.ctx.orgId, req.params.id);
  assertVisible(req, lead);
  const result = rescoreLead(req.ctx.orgId, lead.id);
  res.json({ ...result, lead: shapeLead(loadLead(req.ctx.orgId, lead.id)) });
}));

leadsRouter.post('/:id/automation', requirePermission('leads:write'), ah((req, res) => {
  const { paused } = z.object({ paused: z.boolean() }).parse(req.body);
  const lead = loadLead(req.ctx.orgId, req.params.id);
  assertVisible(req, lead);
  run('UPDATE leads SET automation_paused = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
    paused ? 1 : 0, nowIso(), lead.id, req.ctx.orgId,
  ]);
  if (paused) {
    run("UPDATE automation_runs SET status = 'stopped', stopped_reason = 'paused', next_run_at = NULL WHERE org_id = ? AND lead_id = ? AND status = 'active'", [
      req.ctx.orgId, lead.id,
    ]);
  }
  logActivity({
    orgId: req.ctx.orgId, leadId: lead.id, type: 'automation',
    title: paused ? 'Automation paused for this lead' : 'Automation resumed for this lead',
    userId: req.ctx.user.id,
  });
  res.json({ lead: shapeLead(loadLead(req.ctx.orgId, lead.id)) });
}));

// --- activities -----------------------------------------------------------

const activitySchema = z.object({
  type: z.enum(['note', 'call', 'email', 'whatsapp', 'sms', 'meeting']),
  direction: z.enum(['inbound', 'outbound', 'internal']).default('outbound'),
  title: z.string().optional(),
  body: z.string().optional(),
  outcome: z.enum(['answered', 'no_answer', 'voicemail', 'callback', 'interested', 'not_interested']).nullish(),
  duration_sec: z.number().int().nonnegative().nullish(),
  occurred_at: z.string().optional(),
});

leadsRouter.post('/:id/activities', requirePermission('leads:write'), ah((req, res) => {
  const lead = loadLead(req.ctx.orgId, req.params.id);
  assertVisible(req, lead);
  const body = activitySchema.parse(req.body);
  const defaults: Record<string, string> = {
    note: 'Note added', call: 'Call logged', email: 'Email logged',
    whatsapp: 'WhatsApp message logged', sms: 'SMS logged', meeting: 'Meeting logged',
  };
  const id = logActivity({
    orgId: req.ctx.orgId,
    leadId: lead.id,
    type: body.type,
    direction: body.direction,
    title: body.title?.trim() || defaults[body.type],
    body: body.body ?? null,
    outcome: body.outcome ?? null,
    durationSec: body.duration_sec ?? null,
    occurredAt: body.occurred_at,
    userId: req.ctx.user.id,
    isCustomerTouch: body.type !== 'note',
  });
  rescoreLead(req.ctx.orgId, lead.id);
  res.status(201).json({
    activity: get('SELECT * FROM activities WHERE id = ?', [id]),
    lead: shapeLead(loadLead(req.ctx.orgId, lead.id)),
  });
}));

// --- tags -----------------------------------------------------------------

leadsRouter.put('/:id/tags', requirePermission('leads:write'), ah((req, res) => {
  const { tags } = z.object({ tags: z.array(z.string()) }).parse(req.body);
  const lead = loadLead(req.ctx.orgId, req.params.id);
  assertVisible(req, lead);
  applyTags(req.ctx.orgId, lead.id, tags);
  res.json({ tags: listLeadTags(req.ctx.orgId, lead.id) });
}));

function applyTags(orgId: string, leadId: string, tagNames: string[]): void {
  run('DELETE FROM lead_tags WHERE org_id = ? AND lead_id = ?', [orgId, leadId]);
  for (const name of tagNames.map((t) => t.trim()).filter(Boolean)) {
    let tag = get<{ id: string }>('SELECT id FROM tags WHERE org_id = ? AND name = ?', [orgId, name]);
    if (!tag) {
      const id = newId('tag');
      insert('tags', { id, org_id: orgId, name, created_at: nowIso() });
      tag = { id };
    }
    run('INSERT OR IGNORE INTO lead_tags (org_id, lead_id, tag_id) VALUES (?, ?, ?)', [orgId, leadId, tag.id]);
  }
}

// --- convert to customer --------------------------------------------------

leadsRouter.post('/:id/customer', requirePermission('customers:write'), ah((req, res) => {
  const lead = loadLead(req.ctx.orgId, req.params.id);
  assertVisible(req, lead);
  const customerId = ensureCustomerForLead(req.ctx.orgId, lead.id, req.ctx.user.id);
  res.json({ customer_id: customerId, lead: shapeLead(loadLead(req.ctx.orgId, lead.id)) });
}));

// --- helpers --------------------------------------------------------------

export function assertVisible(req: any, lead: any): void {
  if (req.ctx.seesAll()) return;
  if (lead.owner_id === req.ctx.user.id) return;
  throw forbidden('This lead belongs to another salesperson.');
}

export { recomputeNextAction, emit, notFound, badRequest };
