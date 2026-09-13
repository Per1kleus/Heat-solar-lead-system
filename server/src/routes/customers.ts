import { Router } from 'express';
import { z } from 'zod';
import { all, get, insert, run } from '../lib/db.ts';
import { ah } from '../middleware/errors.ts';
import { requirePermission } from '../middleware/context.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { notFound, badRequest } from '../lib/errors.ts';
import { audit } from '../lib/audit.ts';
import { logActivity } from '../lib/leads.ts';

export const customersRouter = Router();

customersRouter.get('/', requirePermission('customers:read'), ah((req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const where = ['c.org_id = ?'];
  const params: any[] = [req.ctx.orgId];
  if (q.search) {
    const term = `%${q.search.toLowerCase()}%`;
    where.push('(lower(c.first_name) LIKE ? OR lower(c.last_name) LIKE ? OR lower(c.email) LIKE ? OR c.phone LIKE ? OR lower(c.company) LIKE ?)');
    params.push(term, term, term, term, term);
  }
  if (q.city) { where.push('lower(c.city) = ?'); params.push(q.city.toLowerCase()); }
  if (q.owner_id) { where.push('c.owner_id = ?'); params.push(q.owner_id); }

  const rows = all<any>(
    `SELECT c.*, u.first_name AS owner_first_name, u.last_name AS owner_last_name,
            (SELECT COUNT(*) FROM projects p WHERE p.customer_id = c.id) AS project_count,
            (SELECT COALESCE(SUM(p.contract_value), 0) FROM projects p WHERE p.customer_id = c.id AND p.status != 'cancelled') AS total_value,
            (SELECT COUNT(*) FROM leads l WHERE l.customer_id = c.id AND l.status = 'open' AND l.deleted_at IS NULL) AS open_leads
     FROM customers c LEFT JOIN users u ON u.id = c.owner_id
     WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC LIMIT ?`,
    [...params, Math.min(Number(q.limit ?? 100), 300)],
  );
  res.json({
    customers: rows.map((c) => ({
      ...c,
      full_name: `${c.first_name} ${c.last_name}`,
      marketing_consent: !!c.marketing_consent,
      owner_name: c.owner_first_name ? `${c.owner_first_name} ${c.owner_last_name}` : null,
    })),
    total: get<{ n: number }>(`SELECT COUNT(*) AS n FROM customers c WHERE ${where.join(' AND ')}`, params)?.n ?? 0,
  });
}));

customersRouter.get('/:id', requirePermission('customers:read'), ah((req, res) => {
  const customer = get<any>('SELECT * FROM customers WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]);
  if (!customer) throw notFound('That customer no longer exists.');
  const projects = all<any>(
    `SELECT p.*, u.first_name AS tech_first_name, u.last_name AS tech_last_name
     FROM projects p LEFT JOIN users u ON u.id = p.technician_id
     WHERE p.org_id = ? AND p.customer_id = ? ORDER BY p.created_at DESC`,
    [req.ctx.orgId, customer.id],
  );
  res.json({
    customer: { ...customer, full_name: `${customer.first_name} ${customer.last_name}`, marketing_consent: !!customer.marketing_consent },
    projects,
    leads: all(
      `SELECT l.id, l.reference, l.status, l.estimated_value, l.temperature, l.created_at, l.won_at, l.lost_at,
              st.name AS stage_name, l.project_types
       FROM leads l LEFT JOIN pipeline_stages st ON st.id = l.stage_id
       WHERE l.org_id = ? AND l.customer_id = ? AND l.deleted_at IS NULL ORDER BY l.created_at DESC`,
      [req.ctx.orgId, customer.id],
    ),
    quotations: all(
      'SELECT id, number, title, status, total, currency, sent_at FROM quotations WHERE org_id = ? AND customer_id = ? ORDER BY created_at DESC',
      [req.ctx.orgId, customer.id],
    ),
    documents: all('SELECT * FROM documents WHERE org_id = ? AND customer_id = ? ORDER BY created_at DESC', [
      req.ctx.orgId, customer.id,
    ]),
    activities: all(
      `SELECT a.*, u.first_name, u.last_name FROM activities a LEFT JOIN users u ON u.id = a.user_id
       WHERE a.org_id = ? AND (a.customer_id = ? OR a.lead_id IN (SELECT id FROM leads WHERE customer_id = ?))
       ORDER BY a.occurred_at DESC LIMIT 60`,
      [req.ctx.orgId, customer.id, customer.id],
    ),
  });
}));

const customerSchema = z.object({
  first_name: z.string().min(1),
  last_name: z.string().default(''),
  company: z.string().nullish(),
  vat_number: z.string().nullish(),
  phone: z.string().nullish(),
  email: z.string().email().nullish().or(z.literal('')),
  address: z.string().nullish(),
  city: z.string().nullish(),
  postal_code: z.string().nullish(),
  region: z.string().nullish(),
  preferred_contact: z.enum(['phone', 'email', 'whatsapp', 'sms']).nullish(),
  notes: z.string().nullish(),
  marketing_consent: z.boolean().nullish(),
  owner_id: z.string().nullish(),
});

customersRouter.post('/', requirePermission('customers:write'), ah((req, res) => {
  const body = customerSchema.parse(req.body);
  const id = newId('cus');
  const now = nowIso();
  insert('customers', {
    id, org_id: req.ctx.orgId, ...body, email: body.email || null,
    marketing_consent: body.marketing_consent ? 1 : 0,
    marketing_consent_at: body.marketing_consent ? now : null,
    marketing_consent_source: body.marketing_consent ? 'manual' : null,
    owner_id: body.owner_id ?? req.ctx.user.id,
    became_customer_at: now, created_at: now, updated_at: now,
  });
  audit({
    orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'customer.created', entityType: 'customer',
    entityId: id, entityLabel: `${body.first_name} ${body.last_name}`,
  });
  res.status(201).json({ customer: get('SELECT * FROM customers WHERE id = ?', [id]) });
}));

customersRouter.patch('/:id', requirePermission('customers:write'), ah((req, res) => {
  const customer = get<any>('SELECT * FROM customers WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]);
  if (!customer) throw notFound('That customer no longer exists.');
  const body = customerSchema.partial().parse(req.body);
  const map: Record<string, any> = { ...body };
  if (body.marketing_consent !== undefined) {
    map.marketing_consent = body.marketing_consent ? 1 : 0;
    map.marketing_consent_at = body.marketing_consent ? nowIso() : null;
    map.marketing_consent_source = body.marketing_consent ? 'manual' : null;
  }
  const keys = Object.keys(map).filter((k) => map[k] !== undefined);
  if (keys.length > 0) {
    run(
      `UPDATE customers SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND org_id = ?`,
      [...keys.map((k) => map[k]), nowIso(), customer.id, req.ctx.orgId],
    );
  }
  audit({
    orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'customer.updated', entityType: 'customer',
    entityId: customer.id, entityLabel: `${customer.first_name} ${customer.last_name}`, changes: map,
  });
  res.json({ customer: get('SELECT * FROM customers WHERE id = ?', [customer.id]) });
}));

// --- projects (post-sale handoff) ----------------------------------------

export const projectsRouter = Router();

const PROJECT_SELECT = `
  SELECT p.*, c.first_name AS customer_first_name, c.last_name AS customer_last_name, c.phone AS customer_phone,
         c.address AS customer_address, c.city AS customer_city,
         u.first_name AS tech_first_name, u.last_name AS tech_last_name, u.avatar_color AS tech_color
  FROM projects p
  LEFT JOIN customers c ON c.id = p.customer_id
  LEFT JOIN users u ON u.id = p.technician_id
`;

projectsRouter.get('/', requirePermission('projects:read'), ah((req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const where = ['p.org_id = ?'];
  const params: any[] = [req.ctx.orgId];
  if (q.status) { where.push('p.status = ?'); params.push(q.status); }
  if (q.installation_status) { where.push('p.installation_status = ?'); params.push(q.installation_status); }
  if (req.ctx.role === 'technician') { where.push('p.technician_id = ?'); params.push(req.ctx.user.id); }
  else if (q.technician_id) { where.push('p.technician_id = ?'); params.push(q.technician_id); }
  if (q.customer_id) { where.push('p.customer_id = ?'); params.push(q.customer_id); }

  const rows = all<any>(
    `${PROJECT_SELECT} WHERE ${where.join(' AND ')} ORDER BY COALESCE(p.planned_install_date, p.created_at) DESC LIMIT 300`,
    params,
  );
  res.json({
    projects: rows.map((p) => ({
      ...p,
      customer_name: p.customer_first_name ? `${p.customer_first_name} ${p.customer_last_name}` : null,
      technician_name: p.tech_first_name ? `${p.tech_first_name} ${p.tech_last_name}` : null,
    })),
    summary: {
      pipeline_value: rows.filter((p) => p.status !== 'cancelled').reduce((s, p) => s + Number(p.contract_value || 0), 0),
      outstanding: rows.reduce((s, p) => s + Math.max(0, Number(p.contract_value || 0) - Number(p.amount_paid || 0)), 0),
    },
  });
}));

const projectSchema = z.object({
  customer_id: z.string().min(1, 'A project belongs to a customer.'),
  lead_id: z.string().nullish(),
  name: z.string().min(1, 'Give the project a name.'),
  project_type: z.string().min(1),
  system_size: z.string().nullish(),
  contract_value: z.number().nonnegative().default(0),
  status: z.enum(['opportunity', 'won', 'scheduled', 'in_progress', 'commissioned', 'completed', 'cancelled']).default('won'),
  installation_status: z.enum(['not_started', 'scheduled', 'in_progress', 'commissioned', 'handed_over']).default('not_started'),
  planned_install_date: z.string().nullish(),
  actual_install_date: z.string().nullish(),
  technician_id: z.string().nullish(),
  payment_status: z.enum(['unpaid', 'deposit_paid', 'partially_paid', 'paid']).default('unpaid'),
  amount_paid: z.number().nonnegative().default(0),
  warranty_years: z.number().int().nullish(),
  warranty_expires_at: z.string().nullish(),
  maintenance_due_at: z.string().nullish(),
  technical_notes: z.string().nullish(),
});

projectsRouter.post('/', requirePermission('projects:write'), ah((req, res) => {
  const body = projectSchema.parse(req.body);
  const customer = get('SELECT id FROM customers WHERE id = ? AND org_id = ?', [body.customer_id, req.ctx.orgId]);
  if (!customer) throw badRequest('That customer does not exist in this organisation.');
  const id = newId('prj');
  const now = nowIso();
  insert('projects', { id, org_id: req.ctx.orgId, ...body, created_at: now, updated_at: now });
  if (body.lead_id) {
    logActivity({
      orgId: req.ctx.orgId, leadId: body.lead_id, projectId: id, type: 'system',
      title: `Project created: ${body.name}`,
      body: `Contract value ${body.contract_value}`, userId: req.ctx.user.id,
    });
  }
  recalcLifetimeValue(req.ctx.orgId, body.customer_id);
  audit({
    orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'project.created', entityType: 'project',
    entityId: id, entityLabel: body.name,
  });
  res.status(201).json({ project: get(`${PROJECT_SELECT} WHERE p.id = ?`, [id]) });
}));

projectsRouter.get('/:id', requirePermission('projects:read'), ah((req, res) => {
  const project = get<any>(`${PROJECT_SELECT} WHERE p.id = ? AND p.org_id = ?`, [req.params.id, req.ctx.orgId]);
  if (!project) throw notFound('That project no longer exists.');
  res.json({
    project,
    documents: all('SELECT * FROM documents WHERE org_id = ? AND project_id = ? ORDER BY created_at DESC', [
      req.ctx.orgId, project.id,
    ]),
    tasks: all("SELECT * FROM tasks WHERE org_id = ? AND project_id = ? ORDER BY (status != 'open'), due_at", [
      req.ctx.orgId, project.id,
    ]),
    surveys: all('SELECT * FROM site_surveys WHERE org_id = ? AND project_id = ?', [req.ctx.orgId, project.id]),
  });
}));

projectsRouter.patch('/:id', requirePermission('projects:write'), ah((req, res) => {
  const project = get<any>('SELECT * FROM projects WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]);
  if (!project) throw notFound('That project no longer exists.');
  const body = projectSchema.partial().parse(req.body);
  const keys = Object.keys(body).filter((k) => (body as any)[k] !== undefined);
  if (keys.length > 0) {
    run(
      `UPDATE projects SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND org_id = ?`,
      [...keys.map((k) => (body as any)[k]), nowIso(), project.id, req.ctx.orgId],
    );
  }
  recalcLifetimeValue(req.ctx.orgId, project.customer_id);
  audit({
    orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'project.updated', entityType: 'project',
    entityId: project.id, entityLabel: project.name, changes: body as Record<string, unknown>,
  });
  res.json({ project: get(`${PROJECT_SELECT} WHERE p.id = ?`, [project.id]) });
}));

function recalcLifetimeValue(orgId: string, customerId: string): void {
  const total = get<{ v: number }>(
    "SELECT COALESCE(SUM(contract_value), 0) AS v FROM projects WHERE org_id = ? AND customer_id = ? AND status != 'cancelled'",
    [orgId, customerId],
  )?.v ?? 0;
  run('UPDATE customers SET lifetime_value = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
    total, nowIso(), customerId, orgId,
  ]);
}
