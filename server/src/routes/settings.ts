import { Router } from 'express';
import { z } from 'zod';
import nodemailer from 'nodemailer';
import { all, get, insert, parseJson, run } from '../lib/db.ts';
import { ah } from '../middleware/errors.ts';
import { requirePermission } from '../middleware/context.ts';
import { newId, randomToken, sha256 } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { audit } from '../lib/audit.ts';
import { hashPassword } from '../lib/auth.ts';
import { assertSeatAllowance, getSubscription } from '../lib/billing.ts';
import { PLANS, type PlanKey } from '../lib/defaults.ts';
import { startSubscription } from '../lib/provision.ts';
import { nextAvatarColor } from '../lib/provision.ts';
import { ROLE_LABELS, ROLE_PERMISSIONS, type Role } from '../lib/permissions.ts';
import { SCORING_EVALUATOR_KEYS } from '../lib/scoring.ts';
import { getIntegration } from '../lib/messaging.ts';

export const settingsRouter = Router();

// --- company --------------------------------------------------------------

settingsRouter.get('/company', requirePermission('settings:read'), ah((req, res) => {
  const org = get<any>('SELECT * FROM organizations WHERE id = ?', [req.ctx.orgId]);
  if (!org) throw notFound('Organisation not found.');
  const { api_key_hash, ...safe } = org;
  void api_key_hash;
  res.json({
    company: { ...safe, services: parseJson<string[]>(org.services, []) },
    embed_snippet: embedSnippet(org),
  });
}));

const companySchema = z.object({
  name: z.string().min(2).optional(),
  logo_url: z.string().nullish(),
  address: z.string().nullish(),
  city: z.string().nullish(),
  postal_code: z.string().nullish(),
  country: z.string().nullish(),
  phone: z.string().nullish(),
  email: z.string().email().nullish().or(z.literal('')),
  website: z.string().nullish(),
  vat_number: z.string().nullish(),
  tax_office: z.string().nullish(),
  registry_number: z.string().nullish(),
  currency: z.string().length(3).optional(),
  timezone: z.string().optional(),
  vat_rate: z.number().min(0).max(100).optional(),
  services: z.array(z.string()).optional(),
  quote_prefix: z.string().max(8).optional(),
  quote_validity_days: z.number().int().min(1).max(365).optional(),
  quote_terms: z.string().nullish(),
  quote_footer: z.string().nullish(),
  privacy_policy_url: z.string().nullish(),
  retention_months: z.number().int().min(0).max(240).optional(),
  stale_lead_hours: z.number().int().min(1).max(720).optional(),
});

settingsRouter.patch('/company', requirePermission('settings:write'), ah((req, res) => {
  const body = companySchema.parse(req.body);
  const map: Record<string, any> = { ...body };
  if (body.services) map.services = JSON.stringify(body.services);
  if (body.logo_url && body.logo_url.length > 400_000) {
    throw badRequest('That logo is too large. Use an image under 300 KB.');
  }
  const keys = Object.keys(map).filter((k) => map[k] !== undefined);
  if (keys.length > 0) {
    run(
      `UPDATE organizations SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...keys.map((k) => map[k]), nowIso(), req.ctx.orgId],
    );
  }
  audit({
    orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'settings.company_updated',
    entityType: 'organization', entityId: req.ctx.orgId, changes: map,
  });
  const org = get<any>('SELECT * FROM organizations WHERE id = ?', [req.ctx.orgId]);
  res.json({ company: { ...org, services: parseJson<string[]>(org.services, []) } });
}));

function embedSnippet(org: any): string {
  const base = process.env.VF_PUBLIC_URL ?? 'https://app.voltaflow.eu';
  return `<div id="voltaflow-form"></div>
<script src="${base}/embed.js" data-voltaflow-token="${org.public_form_token}" defer></script>`;
}

// --- pipeline stages ------------------------------------------------------

settingsRouter.get('/stages', requirePermission('settings:read'), ah((req, res) => {
  res.json({ stages: all('SELECT * FROM pipeline_stages WHERE org_id = ? ORDER BY position', [req.ctx.orgId]) });
}));

const stageSchema = z.object({
  name: z.string().min(1),
  key: z.string().regex(/^[a-z0-9_]+$/, 'Use lowercase letters, numbers and underscores.').optional(),
  probability: z.number().int().min(0).max(100).default(0),
  color: z.string().default('#64748b'),
  type: z.enum(['open', 'won', 'lost']).default('open'),
  stale_days: z.number().int().min(0).max(365).default(7),
  is_active: z.boolean().optional(),
});

settingsRouter.post('/stages', requirePermission('settings:write'), ah((req, res) => {
  const body = stageSchema.parse(req.body);
  const key = body.key ?? body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
  if (get('SELECT 1 FROM pipeline_stages WHERE org_id = ? AND key = ?', [req.ctx.orgId, key])) {
    throw badRequest('A stage with that key already exists.');
  }
  const maxPos = get<{ p: number }>(
    'SELECT COALESCE(MAX(position), -1) AS p FROM pipeline_stages WHERE org_id = ?', [req.ctx.orgId],
  )?.p ?? -1;
  const id = newId('stg');
  insert('pipeline_stages', {
    id, org_id: req.ctx.orgId, key, name: body.name, position: maxPos + 1,
    probability: body.probability, color: body.color, type: body.type,
    stale_days: body.stale_days, created_at: nowIso(),
  });
  audit({ orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'settings.stage_created', entityType: 'pipeline_stage', entityId: id, entityLabel: body.name });
  res.status(201).json({ stage: get('SELECT * FROM pipeline_stages WHERE id = ?', [id]) });
}));

settingsRouter.patch('/stages/:id', requirePermission('settings:write'), ah((req, res) => {
  const stage = get<any>('SELECT * FROM pipeline_stages WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]);
  if (!stage) throw notFound('That stage no longer exists.');
  const body = stageSchema.partial().extend({ position: z.number().int().optional() }).parse(req.body);
  const map: Record<string, any> = { ...body };
  if (body.is_active !== undefined) map.is_active = body.is_active ? 1 : 0;
  delete map.key;
  const keys = Object.keys(map).filter((k) => map[k] !== undefined);
  if (keys.length > 0) {
    run(
      `UPDATE pipeline_stages SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND org_id = ?`,
      [...keys.map((k) => map[k]), stage.id, req.ctx.orgId],
    );
  }
  // Stage probability drives the weighted pipeline, so realign the open leads.
  if (body.probability !== undefined) {
    run("UPDATE leads SET probability = ? WHERE org_id = ? AND stage_id = ? AND status = 'open'", [
      body.probability, req.ctx.orgId, stage.id,
    ]);
  }
  res.json({ stage: get('SELECT * FROM pipeline_stages WHERE id = ?', [stage.id]) });
}));

settingsRouter.post('/stages/reorder', requirePermission('settings:write'), ah((req, res) => {
  const { order } = z.object({ order: z.array(z.string()) }).parse(req.body);
  order.forEach((id, index) => {
    run('UPDATE pipeline_stages SET position = ? WHERE id = ? AND org_id = ?', [index, id, req.ctx.orgId]);
  });
  res.json({ stages: all('SELECT * FROM pipeline_stages WHERE org_id = ? ORDER BY position', [req.ctx.orgId]) });
}));

settingsRouter.delete('/stages/:id', requirePermission('settings:write'), ah((req, res) => {
  const stage = get<any>('SELECT * FROM pipeline_stages WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]);
  if (!stage) throw notFound('That stage no longer exists.');
  const inUse = get<{ n: number }>('SELECT COUNT(*) AS n FROM leads WHERE stage_id = ? AND deleted_at IS NULL', [stage.id])?.n ?? 0;
  if (inUse > 0) {
    // Never orphan leads: deactivate instead of deleting.
    run('UPDATE pipeline_stages SET is_active = 0 WHERE id = ?', [stage.id]);
    return res.json({ ok: true, deactivated: true, message: `${inUse} lead(s) are in this stage, so it was hidden rather than deleted.` });
  }
  run('DELETE FROM pipeline_stages WHERE id = ? AND org_id = ?', [stage.id, req.ctx.orgId]);
  res.json({ ok: true, deactivated: false });
}));

// --- sources, lost reasons, tags, custom fields ---------------------------

settingsRouter.get('/sources', ah((req, res) => {
  res.json({ sources: all('SELECT * FROM lead_sources WHERE org_id = ? ORDER BY is_system DESC, name', [req.ctx.orgId]) });
}));

settingsRouter.post('/sources', requirePermission('settings:write'), ah((req, res) => {
  const body = z.object({
    name: z.string().min(1),
    category: z.enum(['paid', 'organic', 'referral', 'direct', 'other']).default('other'),
    cost_per_month: z.number().min(0).default(0),
  }).parse(req.body);
  const key = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
  if (get('SELECT 1 FROM lead_sources WHERE org_id = ? AND key = ?', [req.ctx.orgId, key])) {
    throw badRequest('A source with that name already exists.');
  }
  const id = newId('src');
  insert('lead_sources', {
    id, org_id: req.ctx.orgId, key, name: body.name, category: body.category,
    cost_per_month: body.cost_per_month, created_at: nowIso(),
  });
  res.status(201).json({ source: get('SELECT * FROM lead_sources WHERE id = ?', [id]) });
}));

settingsRouter.patch('/sources/:id', requirePermission('settings:write'), ah((req, res) => {
  const body = z.object({
    name: z.string().optional(),
    category: z.string().optional(),
    cost_per_month: z.number().min(0).optional(),
    is_active: z.boolean().optional(),
  }).parse(req.body);
  const map: Record<string, any> = { ...body };
  if (body.is_active !== undefined) map.is_active = body.is_active ? 1 : 0;
  const keys = Object.keys(map).filter((k) => map[k] !== undefined);
  if (keys.length === 0) throw badRequest('Nothing to update.');
  run(
    `UPDATE lead_sources SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND org_id = ?`,
    [...keys.map((k) => map[k]), req.params.id, req.ctx.orgId],
  );
  res.json({ source: get('SELECT * FROM lead_sources WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]) });
}));

settingsRouter.get('/lost-reasons', ah((req, res) => {
  res.json({ lost_reasons: all('SELECT * FROM lost_reasons WHERE org_id = ? AND is_active = 1 ORDER BY position', [req.ctx.orgId]) });
}));

settingsRouter.post('/lost-reasons', requirePermission('settings:write'), ah((req, res) => {
  const body = z.object({ name: z.string().min(1), recoverable: z.boolean().default(true) }).parse(req.body);
  const key = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
  if (get('SELECT 1 FROM lost_reasons WHERE org_id = ? AND key = ?', [req.ctx.orgId, key])) {
    throw badRequest('That reason already exists.');
  }
  const id = newId('lrs');
  const maxPos = get<{ p: number }>('SELECT COALESCE(MAX(position), -1) AS p FROM lost_reasons WHERE org_id = ?', [req.ctx.orgId])?.p ?? -1;
  insert('lost_reasons', {
    id, org_id: req.ctx.orgId, key, name: body.name,
    recoverable: body.recoverable ? 1 : 0, position: maxPos + 1, created_at: nowIso(),
  });
  res.status(201).json({ lost_reason: get('SELECT * FROM lost_reasons WHERE id = ?', [id]) });
}));

settingsRouter.delete('/lost-reasons/:id', requirePermission('settings:write'), ah((req, res) => {
  run('UPDATE lost_reasons SET is_active = 0 WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]);
  res.json({ ok: true });
}));

settingsRouter.get('/tags', ah((req, res) => {
  res.json({
    tags: all(
      `SELECT t.*, (SELECT COUNT(*) FROM lead_tags lt WHERE lt.tag_id = t.id) AS usage_count
       FROM tags t WHERE t.org_id = ? ORDER BY t.name`,
      [req.ctx.orgId],
    ),
  });
}));

settingsRouter.get('/custom-fields', ah((req, res) => {
  res.json({
    custom_fields: all('SELECT * FROM custom_fields WHERE org_id = ? ORDER BY entity, position', [req.ctx.orgId])
      .map((f: any) => ({ ...f, options: parseJson(f.options, []), required: !!f.required, show_in_form: !!f.show_in_form })),
  });
}));

settingsRouter.post('/custom-fields', requirePermission('settings:write'), ah((req, res) => {
  const body = z.object({
    entity: z.enum(['lead', 'customer', 'project']).default('lead'),
    label: z.string().min(1),
    type: z.enum(['text', 'number', 'select', 'multiselect', 'boolean', 'date']),
    options: z.array(z.string()).default([]),
    required: z.boolean().default(false),
    show_in_form: z.boolean().default(false),
  }).parse(req.body);
  const key = body.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 30);
  if (get('SELECT 1 FROM custom_fields WHERE org_id = ? AND entity = ? AND key = ?', [req.ctx.orgId, body.entity, key])) {
    throw badRequest('A field with that name already exists.');
  }
  const id = newId('cfd');
  const maxPos = get<{ p: number }>('SELECT COALESCE(MAX(position), -1) AS p FROM custom_fields WHERE org_id = ?', [req.ctx.orgId])?.p ?? -1;
  insert('custom_fields', {
    id, org_id: req.ctx.orgId, entity: body.entity, key, label: body.label, type: body.type,
    options: JSON.stringify(body.options), required: body.required ? 1 : 0,
    show_in_form: body.show_in_form ? 1 : 0, position: maxPos + 1, created_at: nowIso(),
  });
  res.status(201).json({ custom_field: get('SELECT * FROM custom_fields WHERE id = ?', [id]) });
}));

settingsRouter.delete('/custom-fields/:id', requirePermission('settings:write'), ah((req, res) => {
  run('DELETE FROM custom_fields WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]);
  res.json({ ok: true });
}));

// --- scoring & assignment -------------------------------------------------

settingsRouter.get('/scoring', requirePermission('settings:read'), ah((req, res) => {
  res.json({
    rules: all('SELECT * FROM scoring_rules WHERE org_id = ? ORDER BY position', [req.ctx.orgId])
      .map((r: any) => ({ ...r, config: parseJson(r.config, {}), is_active: !!r.is_active })),
    available_factors: SCORING_EVALUATOR_KEYS,
    bands: { hot: 80, warm: 50 },
  });
}));

settingsRouter.patch('/scoring/:id', requirePermission('settings:write'), ah((req, res) => {
  const body = z.object({
    points: z.number().int().min(-50).max(50).optional(),
    label: z.string().optional(),
    config: z.record(z.any()).optional(),
    is_active: z.boolean().optional(),
  }).parse(req.body);
  const map: Record<string, any> = { label: body.label, points: body.points };
  if (body.config) map.config = JSON.stringify(body.config);
  if (body.is_active !== undefined) map.is_active = body.is_active ? 1 : 0;
  const keys = Object.keys(map).filter((k) => map[k] !== undefined);
  if (keys.length === 0) throw badRequest('Nothing to update.');
  run(
    `UPDATE scoring_rules SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND org_id = ?`,
    [...keys.map((k) => map[k]), req.params.id, req.ctx.orgId],
  );
  audit({
    orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'settings.scoring_updated',
    entityType: 'scoring_rule', entityId: req.params.id, changes: map,
  });
  res.json({ rule: get('SELECT * FROM scoring_rules WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]) });
}));

settingsRouter.get('/assignment', requirePermission('settings:read'), ah((req, res) => {
  res.json({
    rules: all('SELECT * FROM assignment_rules WHERE org_id = ? ORDER BY position', [req.ctx.orgId])
      .map((r: any) => ({ ...r, conditions: parseJson(r.conditions, []), is_active: !!r.is_active })),
  });
}));

const assignmentSchema = z.object({
  name: z.string().min(1),
  conditions: z.array(z.object({ field: z.string(), op: z.string(), value: z.any() })).default([]),
  strategy: z.enum(['round_robin', 'specific_user', 'least_open', 'unassigned']).default('round_robin'),
  target_user_id: z.string().nullish(),
  is_active: z.boolean().default(true),
  position: z.number().int().optional(),
});

settingsRouter.post('/assignment', requirePermission('settings:write'), ah((req, res) => {
  const body = assignmentSchema.parse(req.body);
  if (body.strategy === 'specific_user' && !body.target_user_id) {
    throw badRequest('Choose which user this rule assigns to.');
  }
  const id = newId('asr');
  const maxPos = get<{ p: number }>('SELECT COALESCE(MAX(position), -1) AS p FROM assignment_rules WHERE org_id = ?', [req.ctx.orgId])?.p ?? -1;
  insert('assignment_rules', {
    id, org_id: req.ctx.orgId, name: body.name, position: body.position ?? maxPos + 1,
    conditions: JSON.stringify(body.conditions), strategy: body.strategy,
    target_user_id: body.target_user_id ?? null, is_active: body.is_active ? 1 : 0, created_at: nowIso(),
  });
  res.status(201).json({ rule: get('SELECT * FROM assignment_rules WHERE id = ?', [id]) });
}));

settingsRouter.patch('/assignment/:id', requirePermission('settings:write'), ah((req, res) => {
  const body = assignmentSchema.partial().parse(req.body);
  const map: Record<string, any> = {
    name: body.name, strategy: body.strategy, target_user_id: body.target_user_id, position: body.position,
  };
  if (body.conditions) map.conditions = JSON.stringify(body.conditions);
  if (body.is_active !== undefined) map.is_active = body.is_active ? 1 : 0;
  const keys = Object.keys(map).filter((k) => map[k] !== undefined);
  if (keys.length === 0) throw badRequest('Nothing to update.');
  run(
    `UPDATE assignment_rules SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND org_id = ?`,
    [...keys.map((k) => map[k]), req.params.id, req.ctx.orgId],
  );
  res.json({ rule: get('SELECT * FROM assignment_rules WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]) });
}));

settingsRouter.delete('/assignment/:id', requirePermission('settings:write'), ah((req, res) => {
  run('DELETE FROM assignment_rules WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]);
  res.json({ ok: true });
}));

// --- message templates ----------------------------------------------------

settingsRouter.get('/templates', requirePermission('settings:read'), ah((req, res) => {
  res.json({ templates: all('SELECT * FROM message_templates WHERE org_id = ? ORDER BY name', [req.ctx.orgId]) });
}));

settingsRouter.patch('/templates/:id', requirePermission('settings:write'), ah((req, res) => {
  const body = z.object({
    name: z.string().optional(),
    subject: z.string().nullish(),
    body: z.string().optional(),
    is_active: z.boolean().optional(),
    purpose: z.enum(['operational', 'marketing']).optional(),
  }).parse(req.body);
  const map: Record<string, any> = { name: body.name, subject: body.subject, body: body.body, purpose: body.purpose };
  if (body.is_active !== undefined) map.is_active = body.is_active ? 1 : 0;
  const keys = Object.keys(map).filter((k) => map[k] !== undefined);
  if (keys.length === 0) throw badRequest('Nothing to update.');
  run(
    `UPDATE message_templates SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND org_id = ?`,
    [...keys.map((k) => map[k]), nowIso(), req.params.id, req.ctx.orgId],
  );
  res.json({ template: get('SELECT * FROM message_templates WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]) });
}));

// --- users ----------------------------------------------------------------

settingsRouter.get('/users', requirePermission('users:read'), ah((req, res) => {
  const users = all<any>(
    `SELECT u.id, u.email, u.first_name, u.last_name, u.phone, u.role, u.status, u.avatar_color,
            u.last_login_at, u.created_at,
            (SELECT COUNT(*) FROM leads l WHERE l.owner_id = u.id AND l.status = 'open' AND l.deleted_at IS NULL) AS open_leads,
            (SELECT COUNT(*) FROM tasks t WHERE t.assignee_id = u.id AND t.status = 'open') AS open_tasks
     FROM users u WHERE u.org_id = ? ORDER BY u.created_at`,
    [req.ctx.orgId],
  );
  res.json({
    users: users.map((u) => ({ ...u, full_name: `${u.first_name} ${u.last_name}`, role_label: ROLE_LABELS[u.role as Role] })),
    roles: Object.entries(ROLE_LABELS).map(([key, label]) => ({
      key, label, permissions: ROLE_PERMISSIONS[key as Role],
    })),
    subscription: getSubscription(req.ctx.orgId),
  });
}));

settingsRouter.post('/users', requirePermission('users:write'), ah((req, res) => {
  const body = z.object({
    email: z.string().email('Enter a valid email address.'),
    first_name: z.string().min(1),
    last_name: z.string().default(''),
    phone: z.string().nullish(),
    role: z.enum(['owner', 'admin', 'sales_manager', 'salesperson', 'technician']),
    password: z.string().min(10).optional(),
  }).parse(req.body);

  assertSeatAllowance(req.ctx.orgId);
  const email = body.email.trim().toLowerCase();
  if (get('SELECT 1 FROM users WHERE email = ?', [email])) {
    throw badRequest('Someone already uses that email address.');
  }
  if (body.role === 'owner' && req.ctx.role !== 'owner') {
    throw forbidden('Only the account owner can create another owner.');
  }

  const id = newId('usr');
  const now = nowIso();
  const inviteToken = body.password ? null : randomToken(24);
  insert('users', {
    id, org_id: req.ctx.orgId, email,
    password_hash: body.password ? hashPassword(body.password) : hashPassword(randomToken(24)),
    first_name: body.first_name, last_name: body.last_name, phone: body.phone ?? null,
    avatar_color: nextAvatarColor(req.ctx.orgId), role: body.role,
    status: body.password ? 'active' : 'invited',
    invite_token: inviteToken ? sha256(inviteToken) : null,
    created_at: now, updated_at: now,
  });
  audit({
    orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'user.added', entityType: 'user', entityId: id,
    entityLabel: `${body.first_name} ${body.last_name}`, changes: { role: body.role },
  });
  res.status(201).json({
    user: get('SELECT id, email, first_name, last_name, role, status, avatar_color FROM users WHERE id = ?', [id]),
    // The invite link is returned so an admin can pass it on however they prefer;
    // it is not emailed unless a mailbox is connected.
    invite_link: inviteToken ? `/accept-invite?token=${inviteToken}` : null,
    email_connected: getIntegration(req.ctx.orgId, 'smtp')?.status === 'connected',
  });
}));

settingsRouter.patch('/users/:id', requirePermission('users:write'), ah((req, res) => {
  const target = get<any>('SELECT * FROM users WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]);
  if (!target) throw notFound('That user is not in this organisation.');
  const body = z.object({
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    phone: z.string().nullish(),
    role: z.enum(['owner', 'admin', 'sales_manager', 'salesperson', 'technician']).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  }).parse(req.body);

  if (body.role && req.ctx.role !== 'owner' && (body.role === 'owner' || target.role === 'owner')) {
    throw forbidden('Only the account owner can change owner-level access.');
  }
  if (target.id === req.ctx.user.id && body.status === 'disabled') {
    throw badRequest('You cannot disable your own account.');
  }
  if (target.role === 'owner' && body.role && body.role !== 'owner') {
    const owners = get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND role = 'owner' AND status = 'active'", [req.ctx.orgId])?.n ?? 0;
    if (owners <= 1) throw badRequest('The organisation must keep at least one owner.');
  }

  const keys = Object.keys(body).filter((k) => (body as any)[k] !== undefined);
  if (keys.length > 0) {
    run(
      `UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND org_id = ?`,
      [...keys.map((k) => (body as any)[k]), nowIso(), target.id, req.ctx.orgId],
    );
  }
  if (body.status === 'disabled') {
    run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), target.id]);
  }
  audit({
    orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'user.updated', entityType: 'user',
    entityId: target.id, entityLabel: `${target.first_name} ${target.last_name}`, changes: body as Record<string, unknown>,
  });
  res.json({ user: get('SELECT id, email, first_name, last_name, role, status FROM users WHERE id = ?', [target.id]) });
}));

// --- current user profile -------------------------------------------------

settingsRouter.patch('/profile', ah((req, res) => {
  const body = z.object({
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    phone: z.string().nullish(),
    theme: z.enum(['light', 'dark', 'system']).optional(),
    notif_prefs: z.record(z.boolean()).optional(),
  }).parse(req.body);
  const map: Record<string, any> = {
    first_name: body.first_name, last_name: body.last_name, phone: body.phone, theme: body.theme,
  };
  if (body.notif_prefs) map.notif_prefs = JSON.stringify(body.notif_prefs);
  const keys = Object.keys(map).filter((k) => map[k] !== undefined);
  if (keys.length > 0) {
    run(
      `UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...keys.map((k) => map[k]), nowIso(), req.ctx.user.id],
    );
  }
  res.json({ user: get('SELECT id, first_name, last_name, phone, theme, notif_prefs FROM users WHERE id = ?', [req.ctx.user.id]) });
}));

// --- integrations ---------------------------------------------------------

const PROVIDER_LABELS: Record<string, string> = {
  smtp: 'Email (SMTP)',
  whatsapp_cloud: 'WhatsApp Business Cloud',
  meta_lead_ads: 'Meta Lead Ads',
  google_ads: 'Google Ads',
  telephony: 'Telephony / click-to-call',
  anthropic: 'AI assistance (Claude)',
};

settingsRouter.get('/integrations', requirePermission('integrations:read'), ah((req, res) => {
  const rows = all<any>('SELECT * FROM integrations WHERE org_id = ? ORDER BY provider', [req.ctx.orgId]);
  res.json({
    integrations: rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      label: PROVIDER_LABELS[r.provider] ?? r.provider,
      status: r.status,
      // Secrets never leave the server; only a masked hint is returned.
      config: parseJson<Record<string, any>>(r.config, {}),
      has_secrets: Object.keys(parseJson<Record<string, any>>(r.secrets, {})).length > 0,
      last_error: r.last_error,
      last_checked_at: r.last_checked_at,
    })),
  });
}));

settingsRouter.put('/integrations/:provider', requirePermission('integrations:write'), ah(async (req, res) => {
  const provider = req.params.provider;
  if (!PROVIDER_LABELS[provider]) throw badRequest('Unknown integration.');
  const body = z.object({
    config: z.record(z.any()).default({}),
    secrets: z.record(z.string()).optional(),
    enabled: z.boolean().default(true),
  }).parse(req.body);

  const existing = get<any>('SELECT * FROM integrations WHERE org_id = ? AND provider = ?', [req.ctx.orgId, provider]);
  const secrets = { ...parseJson<Record<string, any>>(existing?.secrets, {}), ...(body.secrets ?? {}) };

  let status: 'connected' | 'disconnected' | 'error' = body.enabled ? 'connected' : 'disconnected';
  let lastError: string | null = null;

  // Verify before claiming a connection: SMTP is checked against the real server.
  if (body.enabled && provider === 'smtp') {
    try {
      const transport = nodemailer.createTransport({
        host: body.config.host,
        port: Number(body.config.port ?? 587),
        secure: Boolean(body.config.secure),
        auth: secrets.user ? { user: secrets.user, pass: secrets.pass } : undefined,
        connectionTimeout: 10_000,
      });
      await transport.verify();
    } catch (err) {
      status = 'error';
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  if (body.enabled && provider === 'anthropic' && !secrets.api_key) {
    status = 'error';
    lastError = 'An API key is required to enable AI assistance.';
  }
  if (body.enabled && provider === 'whatsapp_cloud' && (!body.config.phone_number_id || !secrets.access_token)) {
    status = 'error';
    lastError = 'A phone number id and an access token are required.';
  }

  const now = nowIso();
  if (existing) {
    run(
      `UPDATE integrations SET config = ?, secrets = ?, status = ?, last_error = ?, last_checked_at = ?, updated_at = ?
       WHERE org_id = ? AND provider = ?`,
      [JSON.stringify(body.config), JSON.stringify(secrets), status, lastError, now, now, req.ctx.orgId, provider],
    );
  } else {
    insert('integrations', {
      id: newId('int'), org_id: req.ctx.orgId, provider, status,
      config: JSON.stringify(body.config), secrets: JSON.stringify(secrets),
      last_error: lastError, last_checked_at: now, created_at: now, updated_at: now,
    });
  }
  audit({
    orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'integration.updated', entityType: 'integration',
    entityId: provider, entityLabel: PROVIDER_LABELS[provider], changes: { status },
  });
  res.status(status === 'error' ? 400 : 200).json({
    integration: { provider, status, config: body.config, last_error: lastError },
    message: status === 'connected'
      ? `${PROVIDER_LABELS[provider]} is connected.`
      : status === 'error'
        ? `Could not connect: ${lastError}`
        : `${PROVIDER_LABELS[provider]} is disconnected.`,
  });
}));

// --- API key for the public intake API ------------------------------------

settingsRouter.post('/api-key', requirePermission('integrations:write'), ah((req, res) => {
  const key = `vf_${randomToken(24)}`;
  run('UPDATE organizations SET api_key_hash = ?, api_key_hint = ?, updated_at = ? WHERE id = ?', [
    sha256(key), `${key.slice(0, 10)}...${key.slice(-4)}`, nowIso(), req.ctx.orgId,
  ]);
  audit({ orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'settings.api_key_rotated', entityType: 'organization', entityId: req.ctx.orgId });
  // Shown once; only the hash is stored.
  res.json({ api_key: key, hint: `${key.slice(0, 10)}...${key.slice(-4)}` });
}));

settingsRouter.post('/form-token', requirePermission('settings:write'), ah((req, res) => {
  const token = randomToken(16);
  run('UPDATE organizations SET public_form_token = ?, updated_at = ? WHERE id = ?', [token, nowIso(), req.ctx.orgId]);
  const org = get<any>('SELECT * FROM organizations WHERE id = ?', [req.ctx.orgId]);
  res.json({ public_form_token: token, embed_snippet: embedSnippet(org) });
}));

// --- subscription ---------------------------------------------------------

settingsRouter.get('/subscription', requirePermission('billing:read', 'settings:read'), ah((req, res) => {
  res.json({ subscription: getSubscription(req.ctx.orgId), plans: PLANS });
}));

settingsRouter.post('/subscription', requirePermission('billing:write'), ah((req, res) => {
  const { plan } = z.object({ plan: z.enum(['trial', 'starter', 'growth', 'pro']) }).parse(req.body);
  const seatsUsed = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND status IN ('active','invited')", [req.ctx.orgId],
  )?.n ?? 0;
  if (seatsUsed > PLANS[plan as PlanKey].seats) {
    throw badRequest(
      `You have ${seatsUsed} users but the ${PLANS[plan as PlanKey].name} plan includes ${PLANS[plan as PlanKey].seats}. Remove users first.`,
    );
  }
  startSubscription(req.ctx.orgId, plan as PlanKey);
  audit({
    orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'billing.plan_changed', entityType: 'subscription',
    entityId: req.ctx.orgId, changes: { plan },
  });
  res.json({ subscription: getSubscription(req.ctx.orgId) });
}));
