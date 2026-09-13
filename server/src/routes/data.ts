import { Router } from 'express';
import { z } from 'zod';
import { all, get, insert, parseJson, run } from '../lib/db.ts';
import { ah } from '../middleware/errors.ts';
import { requirePermission } from '../middleware/context.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { audit } from '../lib/audit.ts';
import { createLead, findDuplicates, normalizePhone } from '../lib/leads.ts';
import { assertLeadAllowance, getSubscription } from '../lib/billing.ts';
import { seedDemoData, removeDemoData } from '../db/demo.ts';

export const dataRouter = Router();

// --- global search --------------------------------------------------------

dataRouter.get('/search', ah((req, res) => {
  const term = String(req.query.q ?? '').trim().toLowerCase();
  if (term.length < 2) return res.json({ results: [] });
  const like = `%${term}%`;
  const { orgId } = req.ctx;
  const mine = !req.ctx.seesAll();
  const results: any[] = [];

  const leads = all<any>(
    `SELECT l.id, l.reference, l.first_name, l.last_name, l.city, l.status, l.estimated_value, l.temperature
     FROM leads l WHERE l.org_id = ? AND l.deleted_at IS NULL ${mine ? 'AND l.owner_id = ?' : ''}
       AND (lower(l.first_name) LIKE ? OR lower(l.last_name) LIKE ? OR lower(l.email) LIKE ?
            OR l.phone LIKE ? OR lower(l.reference) LIKE ? OR lower(l.company) LIKE ?)
     LIMIT 8`,
    mine ? [orgId, req.ctx.user.id, like, like, like, like, like, like] : [orgId, like, like, like, like, like, like],
  );
  for (const l of leads) {
    results.push({
      type: 'lead', id: l.id, title: `${l.first_name} ${l.last_name}`,
      subtitle: `${l.reference} · ${l.city ?? 'no city'} · ${l.status}`,
      link: `/leads/${l.id}`, meta: { value: l.estimated_value, temperature: l.temperature },
    });
  }

  for (const c of all<any>(
    `SELECT id, first_name, last_name, city, company FROM customers
     WHERE org_id = ? AND (lower(first_name) LIKE ? OR lower(last_name) LIKE ? OR lower(email) LIKE ?
       OR phone LIKE ? OR lower(company) LIKE ?) LIMIT 6`,
    [orgId, like, like, like, like, like],
  )) {
    results.push({
      type: 'customer', id: c.id, title: `${c.first_name} ${c.last_name}`,
      subtitle: [c.company, c.city].filter(Boolean).join(' · ') || 'Customer',
      link: `/customers/${c.id}`,
    });
  }

  for (const q of all<any>(
    `SELECT id, number, title, status, total, currency FROM quotations
     WHERE org_id = ? AND (lower(number) LIKE ? OR lower(title) LIKE ?) LIMIT 6`,
    [orgId, like, like],
  )) {
    results.push({
      type: 'quotation', id: q.id, title: `${q.number} — ${q.title}`,
      subtitle: `${q.status} · ${q.currency} ${Math.round(q.total)}`, link: `/quotations/${q.id}`,
    });
  }

  for (const p of all<any>(
    'SELECT id, name, project_type, status FROM projects WHERE org_id = ? AND lower(name) LIKE ? LIMIT 5',
    [orgId, like],
  )) {
    results.push({ type: 'project', id: p.id, title: p.name, subtitle: `${p.project_type} · ${p.status}`, link: `/projects/${p.id}` });
  }

  for (const t of all<any>(
    `SELECT id, title, due_at, lead_id FROM tasks WHERE org_id = ? AND status = 'open' AND lower(title) LIKE ?
       ${mine ? 'AND assignee_id = ?' : ''} LIMIT 5`,
    mine ? [orgId, like, req.ctx.user.id] : [orgId, like],
  )) {
    results.push({
      type: 'task', id: t.id, title: t.title,
      subtitle: t.due_at ? `Due ${new Date(t.due_at).toLocaleString('en-GB')}` : 'No due date',
      link: t.lead_id ? `/leads/${t.lead_id}` : '/tasks',
    });
  }

  res.json({ results });
}));

// --- saved views ----------------------------------------------------------

dataRouter.get('/views', ah((req, res) => {
  res.json({
    views: all<any>(
      'SELECT * FROM saved_views WHERE org_id = ? AND (user_id = ? OR is_shared = 1) ORDER BY name',
      [req.ctx.orgId, req.ctx.user.id],
    ).map((v) => ({ ...v, filters: parseJson(v.filters, {}), is_shared: !!v.is_shared, is_mine: v.user_id === req.ctx.user.id })),
  });
}));

dataRouter.post('/views', ah((req, res) => {
  const body = z.object({
    name: z.string().min(1, 'Give the view a name.'),
    entity: z.string().default('lead'),
    filters: z.record(z.any()).default({}),
    is_shared: z.boolean().default(false),
  }).parse(req.body);
  const id = newId('vew');
  insert('saved_views', {
    id, org_id: req.ctx.orgId, user_id: req.ctx.user.id, name: body.name, entity: body.entity,
    filters: JSON.stringify(body.filters), is_shared: body.is_shared ? 1 : 0, created_at: nowIso(),
  });
  res.status(201).json({ view: get('SELECT * FROM saved_views WHERE id = ?', [id]) });
}));

dataRouter.delete('/views/:id', ah((req, res) => {
  const view = get<any>('SELECT * FROM saved_views WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]);
  if (!view) throw notFound('That view no longer exists.');
  if (view.user_id !== req.ctx.user.id && !req.ctx.can('settings:write')) {
    throw badRequest('You can only delete your own saved views.');
  }
  run('DELETE FROM saved_views WHERE id = ? AND org_id = ?', [view.id, req.ctx.orgId]);
  res.json({ ok: true });
}));

// --- CSV export -----------------------------------------------------------

const EXPORTS: Record<string, { sql: string; columns: string[]; permission: string }> = {
  leads: {
    permission: 'data:export',
    columns: [
      'reference', 'first_name', 'last_name', 'company', 'phone', 'email', 'address', 'city', 'postal_code',
      'source', 'owner', 'stage', 'status', 'temperature', 'score', 'estimated_value', 'probability',
      'project_types', 'expected_close_date', 'created_at', 'first_contacted_at', 'last_activity_at',
      'won_at', 'lost_at', 'lost_reason', 'pv_annual_kwh', 'pv_monthly_bill', 'pv_roof_type',
      'pv_desired_kwp', 'hp_property_m2', 'hp_existing_system', 'hp_annual_heating_cost', 'notes',
    ],
    sql: `SELECT l.reference, l.first_name, l.last_name, l.company, l.phone, l.email, l.address, l.city,
                 l.postal_code, s.name AS source, (u.first_name || ' ' || u.last_name) AS owner,
                 st.name AS stage, l.status, l.temperature, l.score, l.estimated_value, l.probability,
                 l.project_types, l.expected_close_date, l.created_at, l.first_contacted_at,
                 l.last_activity_at, l.won_at, l.lost_at, lr.name AS lost_reason,
                 l.pv_annual_kwh, l.pv_monthly_bill, l.pv_roof_type, l.pv_desired_kwp,
                 l.hp_property_m2, l.hp_existing_system, l.hp_annual_heating_cost, l.notes
          FROM leads l
          LEFT JOIN lead_sources s ON s.id = l.source_id
          LEFT JOIN users u ON u.id = l.owner_id
          LEFT JOIN pipeline_stages st ON st.id = l.stage_id
          LEFT JOIN lost_reasons lr ON lr.id = l.lost_reason_id
          WHERE l.org_id = ? AND l.deleted_at IS NULL ORDER BY l.created_at DESC`,
  },
  customers: {
    permission: 'data:export',
    columns: ['first_name', 'last_name', 'company', 'vat_number', 'phone', 'email', 'address', 'city', 'postal_code', 'marketing_consent', 'lifetime_value', 'created_at'],
    sql: `SELECT first_name, last_name, company, vat_number, phone, email, address, city, postal_code,
                 marketing_consent, lifetime_value, created_at
          FROM customers WHERE org_id = ? ORDER BY created_at DESC`,
  },
  quotations: {
    permission: 'data:export',
    columns: ['number', 'customer', 'title', 'status', 'subtotal', 'vat_amount', 'total', 'currency', 'owner', 'sent_at', 'valid_until', 'responded_at', 'created_at'],
    sql: `SELECT q.number, (l.first_name || ' ' || l.last_name) AS customer, q.title, q.status,
                 q.subtotal, q.vat_amount, q.total, q.currency,
                 (u.first_name || ' ' || u.last_name) AS owner,
                 q.sent_at, q.valid_until, q.responded_at, q.created_at
          FROM quotations q
          LEFT JOIN leads l ON l.id = q.lead_id
          LEFT JOIN users u ON u.id = q.owner_id
          WHERE q.org_id = ? ORDER BY q.created_at DESC`,
  },
  source_performance: {
    permission: 'analytics:view',
    columns: ['source', 'category', 'leads', 'contacted', 'quotes', 'won', 'lost', 'revenue'],
    sql: `SELECT s.name AS source, s.category,
                 COUNT(l.id) AS leads,
                 SUM(CASE WHEN l.first_contacted_at IS NOT NULL THEN 1 ELSE 0 END) AS contacted,
                 (SELECT COUNT(*) FROM quotations q JOIN leads l2 ON l2.id = q.lead_id
                   WHERE l2.source_id = s.id AND q.status != 'draft') AS quotes,
                 SUM(CASE WHEN l.status = 'won' THEN 1 ELSE 0 END) AS won,
                 SUM(CASE WHEN l.status = 'lost' THEN 1 ELSE 0 END) AS lost,
                 COALESCE(SUM(CASE WHEN l.status = 'won' THEN l.estimated_value ELSE 0 END), 0) AS revenue
          FROM lead_sources s
          LEFT JOIN leads l ON l.source_id = s.id AND l.deleted_at IS NULL
          WHERE s.org_id = ? GROUP BY s.id ORDER BY revenue DESC`,
  },
  tasks: {
    permission: 'data:export',
    columns: ['title', 'type', 'priority', 'status', 'due_at', 'assignee', 'lead', 'completed_at'],
    sql: `SELECT t.title, t.type, t.priority, t.status, t.due_at,
                 (u.first_name || ' ' || u.last_name) AS assignee,
                 (l.first_name || ' ' || l.last_name) AS lead, t.completed_at
          FROM tasks t
          LEFT JOIN users u ON u.id = t.assignee_id
          LEFT JOIN leads l ON l.id = t.lead_id
          WHERE t.org_id = ? ORDER BY t.created_at DESC`,
  },
};

dataRouter.get('/export/:entity', ah((req, res) => {
  const spec = EXPORTS[req.params.entity];
  if (!spec) throw badRequest(`"${req.params.entity}" cannot be exported.`);
  if (!req.ctx.can(spec.permission as any)) {
    throw badRequest('Your role cannot export this data.');
  }
  const rows = all<any>(spec.sql, [req.ctx.orgId]);
  const csv = toCsv(spec.columns, rows);
  audit({
    orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'data.exported', entityType: 'export',
    entityId: req.params.entity, changes: { rows: rows.length },
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.entity}-${new Date().toISOString().slice(0, 10)}.csv"`);
  // BOM so Excel opens UTF-8 correctly.
  res.send(`﻿${csv}`);
}));

function toCsv(columns: string[], rows: any[]): string {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return /[",\n;]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  return [columns.join(','), ...rows.map((row) => columns.map((c) => escape(row[c])).join(','))].join('\n');
}

// --- CSV import -----------------------------------------------------------

export const IMPORTABLE_FIELDS = [
  { key: 'first_name', label: 'First name', required: true },
  { key: 'last_name', label: 'Last name' },
  { key: 'company', label: 'Company' },
  { key: 'phone', label: 'Phone', requiredOneOf: 'contact' },
  { key: 'email', label: 'Email', requiredOneOf: 'contact' },
  { key: 'address', label: 'Address' },
  { key: 'city', label: 'City' },
  { key: 'postal_code', label: 'Postal code' },
  { key: 'notes', label: 'Notes' },
  { key: 'estimated_value', label: 'Estimated value', type: 'number' },
  { key: 'project_types', label: 'Project type(s)', help: 'pv, heat_pump, battery, ev_charger — comma separated' },
  { key: 'source_key', label: 'Source' },
  { key: 'campaign', label: 'Campaign' },
  { key: 'owner_email', label: 'Owner email' },
  { key: 'pv_annual_kwh', label: 'Annual kWh', type: 'number' },
  { key: 'pv_monthly_bill', label: 'Monthly bill', type: 'number' },
  { key: 'pv_desired_kwp', label: 'Desired kWp', type: 'number' },
  { key: 'pv_roof_type', label: 'Roof type' },
  { key: 'hp_property_m2', label: 'Property m2', type: 'number' },
  { key: 'hp_annual_heating_cost', label: 'Annual heating cost', type: 'number' },
  { key: 'hp_existing_system', label: 'Existing heating system' },
];

dataRouter.get('/import/fields', requirePermission('data:import'), ah((req, res) => {
  res.json({
    fields: IMPORTABLE_FIELDS,
    sources: all('SELECT key, name FROM lead_sources WHERE org_id = ? AND is_active = 1', [req.ctx.orgId]),
    users: all("SELECT id, email, first_name, last_name FROM users WHERE org_id = ? AND status = 'active'", [req.ctx.orgId]),
  });
}));

const importSchema = z.object({
  rows: z.array(z.record(z.any())).min(1, 'The file contains no rows.').max(5000, 'Import at most 5,000 rows at a time.'),
  mapping: z.record(z.string()),
  source_key: z.string().default('other'),
  owner_id: z.string().nullish(),
  skip_duplicates: z.boolean().default(true),
  dry_run: z.boolean().default(true),
});

/**
 * Two-phase import: a dry run validates and reports duplicates and errors, the
 * real run creates the leads. Nothing is written until `dry_run` is false.
 */
dataRouter.post('/import/leads', requirePermission('data:import'), ah((req, res) => {
  const body = importSchema.parse(req.body);
  const { orgId } = req.ctx;
  const subscription = getSubscription(orgId);
  const remaining = subscription.lead_limit - subscription.usage.leads_this_period;

  const valid: Record<string, any>[] = [];
  const errors: { row: number; message: string }[] = [];
  const duplicates: { row: number; name: string; matched_on: string; existing: string }[] = [];
  const seen = new Set<string>();

  body.rows.forEach((raw, index) => {
    const mapped: Record<string, any> = {};
    for (const [column, field] of Object.entries(body.mapping)) {
      if (!field) continue;
      const value = raw[column];
      if (value === undefined || value === null || String(value).trim() === '') continue;
      mapped[field] = String(value).trim();
    }
    if (!mapped.first_name && !mapped.last_name) {
      errors.push({ row: index + 1, message: 'No name in this row.' });
      return;
    }
    if (!mapped.phone && !mapped.email) {
      errors.push({ row: index + 1, message: 'No phone number or email address — the lead could not be followed up.' });
      return;
    }
    if (mapped.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mapped.email)) {
      errors.push({ row: index + 1, message: `"${mapped.email}" is not a valid email address.` });
      return;
    }
    for (const field of IMPORTABLE_FIELDS) {
      if (field.type === 'number' && mapped[field.key] !== undefined) {
        const n = Number(String(mapped[field.key]).replace(/[^\d.,-]/g, '').replace(',', '.'));
        if (Number.isNaN(n)) {
          errors.push({ row: index + 1, message: `"${mapped[field.key]}" is not a number for ${field.label}.` });
          return;
        }
        mapped[field.key] = n;
      }
    }
    if (mapped.project_types) {
      mapped.project_types = String(mapped.project_types).split(/[,;|]/).map((t) => t.trim().toLowerCase().replace(/\s+/g, '_')).filter(Boolean);
    }

    // Duplicates both against the database and within the file itself.
    const key = normalizePhone(mapped.phone) ?? mapped.email?.toLowerCase();
    const existing = findDuplicates(orgId, mapped.phone, mapped.email);
    if (existing.length > 0) {
      duplicates.push({
        row: index + 1, name: `${mapped.first_name ?? ''} ${mapped.last_name ?? ''}`.trim(),
        matched_on: existing[0].matched_on, existing: existing[0].full_name,
      });
      if (body.skip_duplicates) return;
    } else if (key && seen.has(key)) {
      duplicates.push({
        row: index + 1, name: `${mapped.first_name ?? ''} ${mapped.last_name ?? ''}`.trim(),
        matched_on: 'duplicate inside this file', existing: 'earlier row',
      });
      if (body.skip_duplicates) return;
    }
    if (key) seen.add(key);
    valid.push({ ...mapped, _row: index + 1 });
  });

  if (body.dry_run) {
    return res.json({
      dry_run: true,
      total_rows: body.rows.length,
      will_import: valid.length,
      errors,
      duplicates,
      preview: valid.slice(0, 10),
      allowance: { remaining, exceeds: valid.length > remaining },
    });
  }

  if (valid.length > remaining) {
    throw badRequest(
      `This import would create ${valid.length} leads but only ${remaining} remain in your plan this month.`,
    );
  }

  let created = 0;
  const failures: { row: number; message: string }[] = [];
  for (const row of valid) {
    const { _row, owner_email, source_key, ...fields } = row;
    let assignTo = body.owner_id ?? undefined;
    if (owner_email) {
      const owner = get<{ id: string }>('SELECT id FROM users WHERE org_id = ? AND lower(email) = ?', [
        orgId, String(owner_email).toLowerCase(),
      ]);
      if (owner) assignTo = owner.id;
    }
    try {
      assertLeadAllowance(orgId);
      createLead(fields, {
        orgId,
        userId: req.ctx.user.id,
        channel: 'import',
        sourceKey: source_key ?? body.source_key,
        allowDuplicate: true,
        // Imported history should not fire the new-lead follow-up sequence.
        skipAutomation: true,
        assignTo,
        ip: req.ip,
      });
      created += 1;
    } catch (err) {
      failures.push({ row: _row, message: err instanceof Error ? err.message : String(err) });
    }
  }

  audit({
    orgId, userId: req.ctx.user.id, action: 'data.imported', entityType: 'import', entityId: 'leads',
    changes: { created, skipped: duplicates.length, errors: errors.length + failures.length },
  });
  res.json({
    dry_run: false,
    created,
    skipped_duplicates: body.skip_duplicates ? duplicates.length : 0,
    errors: [...errors, ...failures],
  });
}));

// --- audit log ------------------------------------------------------------

dataRouter.get('/audit', requirePermission('audit:read'), ah((req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const where = ['a.org_id = ?'];
  const params: any[] = [req.ctx.orgId];
  if (q.action) { where.push('a.action LIKE ?'); params.push(`${q.action}%`); }
  if (q.entity_type) { where.push('a.entity_type = ?'); params.push(q.entity_type); }
  if (q.entity_id) { where.push('a.entity_id = ?'); params.push(q.entity_id); }
  if (q.user_id) { where.push('a.user_id = ?'); params.push(q.user_id); }
  if (q.from) { where.push('a.created_at >= ?'); params.push(q.from); }
  res.json({
    entries: all<any>(
      `SELECT a.*, u.first_name, u.last_name FROM audit_logs a
       LEFT JOIN users u ON u.id = a.user_id
       WHERE ${where.join(' AND ')} ORDER BY a.created_at DESC LIMIT ?`,
      [...params, Math.min(Number(q.limit ?? 100), 500)],
    ).map((e) => ({
      ...e, changes: parseJson(e.changes, {}),
      user_name: e.first_name ? `${e.first_name} ${e.last_name}` : e.actor_label,
    })),
    total: get<{ n: number }>(`SELECT COUNT(*) AS n FROM audit_logs a WHERE ${where.join(' AND ')}`, params)?.n ?? 0,
  });
}));

// --- GDPR -----------------------------------------------------------------

/** Everything held about one person, for a subject access request. */
dataRouter.get('/gdpr/subject/:type/:id', requirePermission('data:export'), ah((req, res) => {
  const { orgId } = req.ctx;
  const isLead = req.params.type === 'lead';
  const record = isLead
    ? get<any>('SELECT * FROM leads WHERE id = ? AND org_id = ?', [req.params.id, orgId])
    : get<any>('SELECT * FROM customers WHERE id = ? AND org_id = ?', [req.params.id, orgId]);
  if (!record) throw notFound('No record found.');

  const leadIds = isLead
    ? [record.id]
    : all<{ id: string }>('SELECT id FROM leads WHERE org_id = ? AND customer_id = ?', [orgId, record.id]).map((r) => r.id);
  const placeholders = leadIds.length > 0 ? leadIds.map(() => '?').join(',') : "''";

  audit({
    orgId, userId: req.ctx.user.id, action: 'gdpr.subject_access', entityType: req.params.type,
    entityId: record.id, entityLabel: `${record.first_name} ${record.last_name}`,
  });
  res.json({
    exported_at: nowIso(),
    subject: record,
    leads: isLead ? [record] : all(`SELECT * FROM leads WHERE id IN (${placeholders})`, leadIds),
    activities: all(`SELECT * FROM activities WHERE org_id = ? AND lead_id IN (${placeholders})`, [orgId, ...leadIds]),
    messages: all(`SELECT * FROM messages WHERE org_id = ? AND lead_id IN (${placeholders})`, [orgId, ...leadIds]),
    quotations: all(`SELECT * FROM quotations WHERE org_id = ? AND lead_id IN (${placeholders})`, [orgId, ...leadIds]),
    appointments: all(`SELECT * FROM appointments WHERE org_id = ? AND lead_id IN (${placeholders})`, [orgId, ...leadIds]),
    site_surveys: all(`SELECT * FROM site_surveys WHERE org_id = ? AND lead_id IN (${placeholders})`, [orgId, ...leadIds]),
    documents: all(`SELECT id, filename, mime_type, size_bytes, created_at FROM documents WHERE org_id = ? AND lead_id IN (${placeholders})`, [orgId, ...leadIds]),
    consent: {
      marketing: isLead ? !!record.consent_marketing : !!record.marketing_consent,
      basis: isLead ? record.gdpr_basis : record.marketing_consent_source,
      recorded_at: isLead ? record.created_at : record.marketing_consent_at,
    },
  });
}));

/** Erasure request: personal data is overwritten, commercial aggregates are kept. */
dataRouter.post('/gdpr/erase', requirePermission('data:erase'), ah((req, res) => {
  const body = z.object({
    type: z.enum(['lead', 'customer']),
    id: z.string(),
    confirm: z.literal(true, { errorMap: () => ({ message: 'Erasure must be confirmed explicitly.' }) }),
  }).parse(req.body);
  const { orgId } = req.ctx;

  const table = body.type === 'lead' ? 'leads' : 'customers';
  const record = get<any>(`SELECT * FROM ${table} WHERE id = ? AND org_id = ?`, [body.id, orgId]);
  if (!record) throw notFound('No record found.');

  const leadIds = body.type === 'lead'
    ? [record.id]
    : all<{ id: string }>('SELECT id FROM leads WHERE org_id = ? AND customer_id = ?', [orgId, record.id]).map((r) => r.id);

  const now = nowIso();
  for (const leadId of leadIds) {
    run(
      `UPDATE leads SET first_name = 'Erased', last_name = 'contact', company = NULL, phone = NULL, email = NULL,
         address = NULL, postal_code = NULL, notes = NULL, dedupe_key = NULL, intake_payload = NULL,
         custom_data = '{}', updated_at = ? WHERE id = ? AND org_id = ?`,
      [now, leadId, orgId],
    );
    run("UPDATE activities SET body = '[erased]', title = '[erased activity]' WHERE org_id = ? AND lead_id = ?", [orgId, leadId]);
    run("UPDATE messages SET body = '[erased]', subject = NULL, to_address = NULL, from_address = NULL WHERE org_id = ? AND lead_id = ?", [orgId, leadId]);
    run('DELETE FROM documents WHERE org_id = ? AND lead_id = ?', [orgId, leadId]);
  }
  if (body.type === 'customer') {
    run(
      `UPDATE customers SET first_name = 'Erased', last_name = 'contact', company = NULL, vat_number = NULL,
         phone = NULL, email = NULL, address = NULL, postal_code = NULL, notes = NULL,
         marketing_consent = 0, updated_at = ? WHERE id = ? AND org_id = ?`,
      [now, record.id, orgId],
    );
  }
  audit({
    orgId, userId: req.ctx.user.id, action: 'gdpr.erased', entityType: body.type, entityId: body.id,
    changes: { leads_affected: leadIds.length },
  });
  res.json({
    ok: true,
    message: `Personal data erased. ${leadIds.length} lead record(s) were anonymised; commercial totals are retained for accounting.`,
  });
}));

// --- demo data ------------------------------------------------------------

dataRouter.post('/demo', requirePermission('settings:write'), ah((req, res) => {
  const { action } = z.object({ action: z.enum(['load', 'remove']) }).parse(req.body);
  if (action === 'load') {
    const result = seedDemoData(req.ctx.orgId, req.ctx.user.id);
    audit({ orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'demo.loaded', entityType: 'organization', entityId: req.ctx.orgId });
    return res.json({ ok: true, ...result });
  }
  const removed = removeDemoData(req.ctx.orgId);
  audit({ orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'demo.removed', entityType: 'organization', entityId: req.ctx.orgId });
  res.json({ ok: true, removed });
}));
