import { Router } from 'express';
import { z } from 'zod';
import { all, get, run } from '../lib/db.ts';
import { ah } from '../middleware/errors.ts';
import { requirePermission } from '../middleware/context.ts';
import { createTask, completeTask, rescheduleTask } from '../lib/tasks.ts';
import { logActivity, recomputeNextAction } from '../lib/leads.ts';
import { nowIso, startOfDay, addDays } from '../lib/time.ts';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { audit } from '../lib/audit.ts';
import { emit } from '../lib/events.ts';
import { readIdempotent, writeIdempotent } from '../lib/idempotency.ts';
import { resolveChannel, sendTemplate } from '../lib/messaging.ts';

export const tasksRouter = Router();

const TASK_SELECT = `
  SELECT t.*, l.first_name AS lead_first_name, l.last_name AS lead_last_name,
         l.estimated_value AS lead_value, l.temperature AS lead_temperature, l.reference AS lead_reference,
         u.first_name AS assignee_first_name, u.last_name AS assignee_last_name, u.avatar_color AS assignee_color,
         q.number AS quotation_number, q.total AS quotation_total
  FROM tasks t
  LEFT JOIN leads l ON l.id = t.lead_id
  LEFT JOIN users u ON u.id = t.assignee_id
  LEFT JOIN quotations q ON q.id = t.quotation_id
`;

tasksRouter.get('/', requirePermission('tasks:read:own', 'tasks:read:all'), ah((req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const where = ['t.org_id = ?'];
  const params: any[] = [req.ctx.orgId];

  if (!req.ctx.can('tasks:read:all')) { where.push('t.assignee_id = ?'); params.push(req.ctx.user.id); }
  else if (q.assignee_id) {
    if (q.assignee_id === 'unassigned') where.push('t.assignee_id IS NULL');
    else { where.push('t.assignee_id = ?'); params.push(q.assignee_id); }
  }
  where.push('t.status = ?');
  params.push(q.status ?? 'open');
  if (q.lead_id) { where.push('t.lead_id = ?'); params.push(q.lead_id); }
  if (q.priority) { where.push('t.priority = ?'); params.push(q.priority); }
  if (q.type) { where.push('t.type = ?'); params.push(q.type); }
  if (q.bucket === 'overdue') { where.push('t.due_at < ?'); params.push(nowIso()); }
  if (q.bucket === 'today') {
    where.push('t.due_at >= ? AND t.due_at < ?');
    params.push(startOfDay().toISOString(), addDays(startOfDay(), 1));
  }
  if (q.bucket === 'week') {
    where.push('t.due_at >= ? AND t.due_at < ?');
    params.push(startOfDay().toISOString(), addDays(startOfDay(), 7));
  }
  if (q.search) {
    where.push('(lower(t.title) LIKE ? OR lower(l.first_name) LIKE ? OR lower(l.last_name) LIKE ?)');
    const term = `%${q.search.toLowerCase()}%`;
    params.push(term, term, term);
  }

  const limit = Math.min(Number(q.limit ?? 100), 300);
  const rows = all<any>(
    `${TASK_SELECT} WHERE ${where.join(' AND ')}
     ORDER BY (t.due_at IS NULL), t.due_at ASC LIMIT ?`,
    [...params, limit],
  );
  const counts = {
    overdue: get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tasks t WHERE t.org_id = ? AND t.status = 'open' AND t.due_at < ?
        ${req.ctx.can('tasks:read:all') ? '' : 'AND t.assignee_id = ?'}`,
      req.ctx.can('tasks:read:all') ? [req.ctx.orgId, nowIso()] : [req.ctx.orgId, nowIso(), req.ctx.user.id],
    )?.n ?? 0,
    today: get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM tasks t WHERE t.org_id = ? AND t.status = 'open' AND t.due_at >= ? AND t.due_at < ?
        ${req.ctx.can('tasks:read:all') ? '' : 'AND t.assignee_id = ?'}`,
      req.ctx.can('tasks:read:all')
        ? [req.ctx.orgId, startOfDay().toISOString(), addDays(startOfDay(), 1)]
        : [req.ctx.orgId, startOfDay().toISOString(), addDays(startOfDay(), 1), req.ctx.user.id],
    )?.n ?? 0,
  };
  res.json({ tasks: rows, counts });
}));

const taskSchema = z.object({
  title: z.string().min(1, 'Give the task a title.'),
  description: z.string().nullish(),
  type: z.string().default('follow_up'),
  lead_id: z.string().nullish(),
  customer_id: z.string().nullish(),
  project_id: z.string().nullish(),
  quotation_id: z.string().nullish(),
  appointment_id: z.string().nullish(),
  survey_id: z.string().nullish(),
  assignee_id: z.string().nullish(),
  due_at: z.string().nullish(),
  priority: z.enum(['urgent', 'high', 'normal', 'low']).default('normal'),
  recurrence: z.enum(['daily', 'weekly', 'monthly']).nullish(),
  is_next_action: z.boolean().optional(),
});

tasksRouter.post('/', requirePermission('tasks:write'), ah((req, res) => {
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  const cached = readIdempotent<any>(req.ctx.orgId, idempotencyKey);
  if (cached) return res.status(201).json(cached);

  const body = taskSchema.parse(req.body);
  const task = createTask({
    orgId: req.ctx.orgId,
    title: body.title,
    description: body.description,
    type: body.type,
    leadId: body.lead_id,
    customerId: body.customer_id,
    projectId: body.project_id,
    quotationId: body.quotation_id,
    appointmentId: body.appointment_id,
    surveyId: body.survey_id,
    assigneeId: body.assignee_id ?? req.ctx.user.id,
    dueAt: body.due_at,
    priority: body.priority,
    recurrence: body.recurrence,
    isNextAction: body.is_next_action,
    source: 'manual',
    createdBy: req.ctx.user.id,
  });
  const payload = { task: get(`${TASK_SELECT} WHERE t.id = ?`, [task.id]) };
  writeIdempotent(req.ctx.orgId, idempotencyKey, 'POST /tasks', payload);
  res.status(201).json(payload);
}));

tasksRouter.patch('/:id', requirePermission('tasks:write'), ah((req, res) => {
  const task = get<any>('SELECT * FROM tasks WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]);
  if (!task) throw notFound('That task no longer exists.');
  assertTaskAccess(req, task);
  const body = taskSchema.partial().parse(req.body);
  const map: Record<string, any> = {
    title: body.title, description: body.description, type: body.type,
    assignee_id: body.assignee_id, due_at: body.due_at, priority: body.priority,
    recurrence: body.recurrence,
  };
  const keys = Object.keys(map).filter((k) => map[k] !== undefined);
  if (keys.length > 0) {
    run(
      `UPDATE tasks SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND org_id = ?`,
      [...keys.map((k) => map[k]), nowIso(), task.id, req.ctx.orgId],
    );
  }
  if (task.lead_id) recomputeNextAction(req.ctx.orgId, task.lead_id);
  res.json({ task: get(`${TASK_SELECT} WHERE t.id = ?`, [task.id]) });
}));

tasksRouter.post('/:id/complete', requirePermission('tasks:write'), ah((req, res) => {
  const { outcome_note } = z.object({ outcome_note: z.string().nullish() }).parse(req.body ?? {});
  const task = get<any>('SELECT * FROM tasks WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]);
  if (!task) throw notFound('That task no longer exists.');
  assertTaskAccess(req, task);
  completeTask(req.ctx.orgId, task.id, req.ctx.user.id, outcome_note);
  res.json({ task: get(`${TASK_SELECT} WHERE t.id = ?`, [task.id]) });
}));

tasksRouter.post('/:id/reschedule', requirePermission('tasks:write'), ah((req, res) => {
  const { due_at } = z.object({ due_at: z.string().min(1, 'Choose a new date.') }).parse(req.body);
  const task = get<any>('SELECT * FROM tasks WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]);
  if (!task) throw notFound('That task no longer exists.');
  assertTaskAccess(req, task);
  rescheduleTask(req.ctx.orgId, task.id, due_at, req.ctx.user.id);
  res.json({ task: get(`${TASK_SELECT} WHERE t.id = ?`, [task.id]) });
}));

tasksRouter.delete('/:id', requirePermission('tasks:write'), ah((req, res) => {
  const task = get<any>('SELECT * FROM tasks WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]);
  if (!task) throw notFound('That task no longer exists.');
  assertTaskAccess(req, task);
  run("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND org_id = ?", [
    nowIso(), task.id, req.ctx.orgId,
  ]);
  if (task.lead_id) recomputeNextAction(req.ctx.orgId, task.lead_id);
  res.json({ ok: true });
}));

function assertTaskAccess(req: any, task: any): void {
  if (req.ctx.can('tasks:read:all')) return;
  if (task.assignee_id === req.ctx.user.id || task.created_by === req.ctx.user.id) return;
  throw forbidden('That task is assigned to someone else.');
}

// --- appointments & calendar ---------------------------------------------

export const appointmentsRouter = Router();

const APPT_SELECT = `
  SELECT a.*, l.first_name AS lead_first_name, l.last_name AS lead_last_name, l.phone AS lead_phone,
         l.address AS lead_address, l.city AS lead_city, l.estimated_value AS lead_value,
         u.first_name AS assignee_first_name, u.last_name AS assignee_last_name,
         tech.first_name AS tech_first_name, tech.last_name AS tech_last_name, tech.avatar_color AS tech_color
  FROM appointments a
  LEFT JOIN leads l ON l.id = a.lead_id
  LEFT JOIN users u ON u.id = a.assignee_id
  LEFT JOIN users tech ON tech.id = a.technician_id
`;

appointmentsRouter.get('/', requirePermission('appointments:read'), ah((req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const where = ['a.org_id = ?'];
  const params: any[] = [req.ctx.orgId];
  if (q.from) { where.push('a.starts_at >= ?'); params.push(q.from); }
  if (q.to) { where.push('a.starts_at <= ?'); params.push(q.to); }
  if (q.lead_id) { where.push('a.lead_id = ?'); params.push(q.lead_id); }
  if (q.status) { where.push('a.status = ?'); params.push(q.status); }
  if (!req.ctx.seesAll() && req.ctx.role !== 'technician') {
    where.push('(a.assignee_id = ? OR a.technician_id = ?)');
    params.push(req.ctx.user.id, req.ctx.user.id);
  } else if (req.ctx.role === 'technician') {
    where.push('a.technician_id = ?');
    params.push(req.ctx.user.id);
  } else if (q.user_id) {
    where.push('(a.assignee_id = ? OR a.technician_id = ?)');
    params.push(q.user_id, q.user_id);
  }
  res.json({
    appointments: all(`${APPT_SELECT} WHERE ${where.join(' AND ')} ORDER BY a.starts_at LIMIT 500`, params),
  });
}));

const apptSchema = z.object({
  type: z.enum(['site_survey', 'sales_meeting', 'call', 'installation', 'service', 'other']).default('site_survey'),
  title: z.string().min(1, 'Give the appointment a title.'),
  description: z.string().nullish(),
  starts_at: z.string().min(1, 'Choose a start time.'),
  ends_at: z.string().nullish(),
  location: z.string().nullish(),
  lead_id: z.string().nullish(),
  customer_id: z.string().nullish(),
  project_id: z.string().nullish(),
  assignee_id: z.string().nullish(),
  technician_id: z.string().nullish(),
  create_survey: z.boolean().optional(),
  /** Send the customer a confirmation through a connected channel. */
  notify_customer: z.boolean().optional(),
  /** Book anyway despite an overlap the caller has seen and accepted. */
  allow_conflict: z.boolean().optional(),
});

export interface ApptConflict {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  user_id: string;
  user_name: string;
}

/**
 * Anything already booked for the same person over the same period. An installer
 * double-booking a technician is the scheduling mistake that actually happens, so
 * it is refused unless the caller explicitly accepts it.
 */
export function findApptConflicts(
  orgId: string, starts: Date, ends: Date, userIds: (string | null | undefined)[], excludeId?: string,
): ApptConflict[] {
  const ids = [...new Set(userIds.filter(Boolean) as string[])];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return all<ApptConflict>(
    `SELECT a.id, a.title, a.starts_at, a.ends_at,
            COALESCE(a.technician_id, a.assignee_id) AS user_id,
            COALESCE(tech.first_name || ' ' || tech.last_name, u.first_name || ' ' || u.last_name, 'Someone') AS user_name
     FROM appointments a
     LEFT JOIN users u ON u.id = a.assignee_id
     LEFT JOIN users tech ON tech.id = a.technician_id
     WHERE a.org_id = ? AND a.status = 'scheduled'
       AND (a.assignee_id IN (${placeholders}) OR a.technician_id IN (${placeholders}))
       AND a.starts_at < ? AND a.ends_at > ?
       ${excludeId ? 'AND a.id != ?' : ''}
     ORDER BY a.starts_at LIMIT 5`,
    [orgId, ...ids, ...ids, ends.toISOString(), starts.toISOString(), ...(excludeId ? [excludeId] : [])],
  );
}

function conflictError(conflicts: ApptConflict[]): never {
  const first = conflicts[0];
  throw conflict(
    `${first.user_name} is already booked for "${first.title}" at that time.`,
    { conflicts, hint: 'Choose another time, assign someone else, or book it anyway.' },
  );
}

appointmentsRouter.post('/', requirePermission('appointments:write'), ah((req, res) => {
  const body = apptSchema.parse(req.body);
  const { orgId } = req.ctx;
  const starts = new Date(body.starts_at);
  if (Number.isNaN(starts.getTime())) throw badRequest('That start time is not a valid date.');
  const ends = body.ends_at ? new Date(body.ends_at) : new Date(starts.getTime() + 60 * 60 * 1000);
  if (ends <= starts) throw badRequest('The appointment must end after it starts.');

  const lead = body.lead_id
    ? get<any>('SELECT * FROM leads WHERE id = ? AND org_id = ?', [body.lead_id, orgId])
    : null;
  if (body.lead_id && !lead) throw notFound('That lead no longer exists.');

  if (!body.allow_conflict) {
    const conflicts = findApptConflicts(orgId, starts, ends, [body.assignee_id ?? req.ctx.user.id, body.technician_id]);
    if (conflicts.length > 0) conflictError(conflicts);
  }

  const id = newId('apt');
  const now = nowIso();
  run(
    `INSERT INTO appointments (id, org_id, lead_id, customer_id, project_id, type, title, description,
       starts_at, ends_at, location, assignee_id, technician_id, status, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'scheduled', ?,?,?)`,
    [
      id, orgId, body.lead_id ?? null, body.customer_id ?? lead?.customer_id ?? null, body.project_id ?? null,
      body.type, body.title, body.description ?? null, starts.toISOString(), ends.toISOString(),
      body.location ?? [lead?.address, lead?.city].filter(Boolean).join(', ') ?? null,
      body.assignee_id ?? req.ctx.user.id, body.technician_id ?? null, req.ctx.user.id, now, now,
    ],
  );

  let surveyId: string | null = null;
  if (body.type === 'site_survey' && body.create_survey !== false && body.lead_id) {
    surveyId = newId('srv');
    run(
      `INSERT INTO site_surveys (id, org_id, lead_id, customer_id, appointment_id, technician_id, project_type,
         status, scheduled_at, address, findings, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?, 'scheduled', ?,?, '{}', ?,?)`,
      [
        surveyId, orgId, body.lead_id, lead?.customer_id ?? null, id, body.technician_id ?? null,
        primaryProjectType(lead), starts.toISOString(),
        body.location ?? [lead?.address, lead?.city].filter(Boolean).join(', '), now, now,
      ],
    );
  }

  if (body.lead_id) {
    logActivity({
      orgId, leadId: body.lead_id, type: 'appointment',
      title: `${labelType(body.type)} scheduled for ${starts.toLocaleString('en-GB')}`,
      body: body.location ?? null,
      meta: { appointment_id: id, survey_id: surveyId },
      userId: req.ctx.user.id,
    });
    // A booked visit is a strong signal; move the lead forward and rescore.
    emit({ type: 'appointment_booked', orgId, leadId: body.lead_id, appointmentId: id });
    const stage = get<{ id: string; probability: number; position: number }>(
      "SELECT id, probability, position FROM pipeline_stages WHERE org_id = ? AND key = 'site_survey'", [orgId],
    );
    const current = get<{ position: number }>(
      'SELECT position FROM pipeline_stages WHERE id = ?', [lead?.stage_id],
    );
    if (body.type === 'site_survey' && stage && (!current || current.position < stage.position)) {
      run('UPDATE leads SET stage_id = ?, stage_entered_at = ?, probability = ? WHERE id = ? AND org_id = ?', [
        stage.id, now, stage.probability, body.lead_id, orgId,
      ]);
    }
  }
  if (body.technician_id) {
    createTask({
      orgId, title: `Site survey: ${body.title}`, type: 'survey',
      leadId: body.lead_id ?? null, surveyId, appointmentId: id,
      assigneeId: body.technician_id, dueAt: starts.toISOString(), priority: 'high',
      source: 'system', createdBy: req.ctx.user.id, isNextAction: false,
    });
  }
  audit({
    orgId, userId: req.ctx.user.id, action: 'appointment.created', entityType: 'appointment', entityId: id,
    entityLabel: body.title,
  });

  const respond = (notification: AppointmentNotification | null) => {
    run('UPDATE appointments SET confirmation_sent_at = ? WHERE id = ? AND org_id = ?', [
      notification?.sent ? nowIso() : null, id, orgId,
    ]);
    res.status(201).json({
      appointment: get(`${APPT_SELECT} WHERE a.id = ?`, [id]),
      survey_id: surveyId,
      notification,
    });
  };

  if (body.notify_customer && body.lead_id) {
    // The caller waits for the provider's answer: the dialog must be able to say
    // "confirmation sent" or "not sent, because…", never guess.
    void notifyCustomer(orgId, id, body.lead_id, confirmationTemplate(body.type), req.ctx.user.id)
      .then(respond)
      .catch(() => respond({ sent: false, reason: 'The confirmation could not be sent.' }));
    return;
  }
  respond(null);
}));

export interface AppointmentNotification {
  sent: boolean;
  channel?: string;
  reason?: string;
}

function confirmationTemplate(type: string): string {
  if (type === 'site_survey') return 'survey_confirmation';
  if (type === 'installation') return 'installation_confirmation';
  return 'appointment_confirmation';
}

/**
 * Sends one appointment message to the customer through a connected channel.
 * Returns what the provider actually did — a refusal is never dressed up as a
 * send, and the attempt is on the timeline either way.
 */
async function notifyCustomer(
  orgId: string, appointmentId: string, leadId: string, templateKey: string, userId: string | null,
): Promise<AppointmentNotification> {
  const lead = get<any>('SELECT * FROM leads WHERE id = ? AND org_id = ?', [leadId, orgId]);
  if (!lead) return { sent: false, reason: 'That lead no longer exists.' };
  const resolved = resolveChannel(orgId, lead, 'preferred');
  // No address at all: nothing to attempt, and nothing to record.
  if (!resolved.channel) return { sent: false, reason: resolved.reason };
  const result = await sendTemplate({
    orgId, templateKey, channel: resolved.channel, leadId, appointmentId, userId,
    purpose: 'operational',
  });
  return result.sent
    ? { sent: true, channel: resolved.channel }
    : { sent: false, channel: resolved.channel, reason: result.reason };
}

appointmentsRouter.patch('/:id', requirePermission('appointments:write'), ah((req, res) => {
  const { orgId } = req.ctx;
  const appt = get<any>('SELECT * FROM appointments WHERE id = ? AND org_id = ?', [req.params.id, orgId]);
  if (!appt) throw notFound('That appointment no longer exists.');
  const body = apptSchema.partial().extend({
    status: z.enum(['scheduled', 'completed', 'cancelled', 'no_show']).optional(),
    outcome_note: z.string().nullish(),
  }).parse(req.body);

  const rescheduled = Boolean(body.starts_at) && body.starts_at !== appt.starts_at;
  const starts = new Date(body.starts_at ?? appt.starts_at);
  if (Number.isNaN(starts.getTime())) throw badRequest('That start time is not a valid date.');
  const ends = body.ends_at
    ? new Date(body.ends_at)
    : rescheduled
      ? new Date(starts.getTime() + (new Date(appt.ends_at).getTime() - new Date(appt.starts_at).getTime()))
      : new Date(appt.ends_at);
  if (ends <= starts) throw badRequest('The appointment must end after it starts.');

  const staysScheduled = (body.status ?? appt.status) === 'scheduled';
  if (staysScheduled && !body.allow_conflict && (rescheduled || body.assignee_id || body.technician_id)) {
    const conflicts = findApptConflicts(
      orgId, starts, ends,
      [body.assignee_id ?? appt.assignee_id, body.technician_id ?? appt.technician_id],
      appt.id,
    );
    if (conflicts.length > 0) conflictError(conflicts);
  }

  const map: Record<string, any> = {
    title: body.title, description: body.description, location: body.location,
    assignee_id: body.assignee_id, technician_id: body.technician_id,
    status: body.status, outcome_note: body.outcome_note, type: body.type,
    starts_at: body.starts_at ? starts.toISOString() : undefined,
    ends_at: body.starts_at || body.ends_at ? ends.toISOString() : undefined,
    // A moved appointment needs its reminder again.
    reminder_sent_at: rescheduled ? null : undefined,
  };
  const keys = Object.keys(map).filter((k) => map[k] !== undefined);
  if (keys.length > 0) {
    run(
      `UPDATE appointments SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND org_id = ?`,
      [...keys.map((k) => map[k]), nowIso(), appt.id, orgId],
    );
  }
  if (rescheduled) {
    run('UPDATE site_surveys SET scheduled_at = ?, updated_at = ? WHERE appointment_id = ? AND org_id = ?', [
      starts.toISOString(), nowIso(), appt.id, orgId,
    ]);
    run("UPDATE tasks SET due_at = ? WHERE appointment_id = ? AND org_id = ? AND status = 'open'", [
      starts.toISOString(), appt.id, orgId,
    ]);
  }
  if (body.status && body.status !== 'scheduled') {
    run("UPDATE tasks SET status = 'cancelled' WHERE appointment_id = ? AND org_id = ? AND status = 'open'", [
      appt.id, orgId,
    ]);
    if (body.status === 'cancelled') {
      run("UPDATE site_surveys SET status = 'cancelled', updated_at = ? WHERE appointment_id = ? AND org_id = ? AND status != 'completed'", [
        nowIso(), appt.id, orgId,
      ]);
    }
  }

  if (appt.lead_id && (body.status || rescheduled)) {
    logActivity({
      orgId, leadId: appt.lead_id, type: 'appointment',
      title: body.status && body.status !== 'scheduled'
        ? `Appointment ${STATUS_LABEL[body.status]}: ${appt.title}`
        : `Appointment moved to ${starts.toLocaleString('en-GB')}`,
      body: body.outcome_note ?? null, userId: req.ctx.user.id,
      meta: { appointment_id: appt.id },
    });
  }
  if (body.status === 'cancelled') {
    emit({ type: 'appointment_cancelled', orgId, leadId: appt.lead_id, appointmentId: appt.id });
  }
  audit({
    orgId, userId: req.ctx.user.id,
    action: body.status ? `appointment.${body.status}` : 'appointment.updated',
    entityType: 'appointment', entityId: appt.id, entityLabel: appt.title,
    changes: rescheduled ? { starts_at: { from: appt.starts_at, to: starts.toISOString() } } : undefined,
  });

  const finish = (notification: AppointmentNotification | null) => {
    res.json({ appointment: get(`${APPT_SELECT} WHERE a.id = ?`, [appt.id]), notification });
  };
  const template = body.status === 'cancelled'
    ? 'appointment_cancelled'
    : rescheduled ? 'appointment_rescheduled' : null;
  if (body.notify_customer && template && appt.lead_id) {
    void notifyCustomer(orgId, appt.id, appt.lead_id, template, req.ctx.user.id)
      .then(finish)
      .catch(() => finish({ sent: false, reason: 'The message could not be sent.' }));
    return;
  }
  finish(null);
}));

const STATUS_LABEL: Record<string, string> = {
  scheduled: 'scheduled', completed: 'completed', cancelled: 'cancelled', no_show: 'missed',
};

function labelType(type: string): string {
  return ({
    site_survey: 'Site survey', sales_meeting: 'Sales meeting', call: 'Call',
    installation: 'Installation', service: 'Service visit', other: 'Appointment',
  } as Record<string, string>)[type] ?? 'Appointment';
}

function primaryProjectType(lead: any): string {
  if (!lead) return 'pv';
  try {
    const types = JSON.parse(lead.project_types ?? '[]');
    return types[0] ?? 'pv';
  } catch { return 'pv'; }
}

// --- unified calendar feed -----------------------------------------------

export const calendarRouter = Router();

calendarRouter.get('/', ah((req, res) => {
  const { from, to } = req.query as Record<string, string | undefined>;
  const start = from ?? startOfDay().toISOString();
  const end = to ?? addDays(startOfDay(), 31);
  const { orgId } = req.ctx;
  const mine = !req.ctx.seesAll();
  const userId = req.ctx.user.id;

  const appointments = all<any>(
    `${APPT_SELECT} WHERE a.org_id = ? AND a.starts_at >= ? AND a.starts_at <= ? AND a.status != 'cancelled'
       ${mine ? 'AND (a.assignee_id = ? OR a.technician_id = ?)' : ''}`,
    mine ? [orgId, start, end, userId, userId] : [orgId, start, end],
  ).map((a) => ({
    id: a.id, kind: 'appointment' as const, type: a.type, title: a.title,
    start: a.starts_at, end: a.ends_at, lead_id: a.lead_id,
    subtitle: a.lead_first_name ? `${a.lead_first_name} ${a.lead_last_name}` : a.location,
    owner: a.tech_first_name ?? a.assignee_first_name, status: a.status,
  }));

  const tasks = all<any>(
    `SELECT t.id, t.title, t.due_at, t.type, t.priority, t.status, t.lead_id,
            l.first_name, l.last_name, u.first_name AS owner_first_name
     FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id LEFT JOIN users u ON u.id = t.assignee_id
     WHERE t.org_id = ? AND t.status = 'open' AND t.due_at >= ? AND t.due_at <= ?
       ${mine ? 'AND t.assignee_id = ?' : ''}`,
    mine ? [orgId, start, end, userId] : [orgId, start, end],
  ).map((t) => ({
    id: t.id, kind: 'task' as const, type: t.type, title: t.title,
    start: t.due_at, end: t.due_at, lead_id: t.lead_id,
    subtitle: t.first_name ? `${t.first_name} ${t.last_name}` : null,
    owner: t.owner_first_name, priority: t.priority, status: t.status,
  }));

  const quoteDeadlines = all<any>(
    `SELECT q.id, q.number, q.title, q.valid_until, q.total, q.currency, q.lead_id, q.status,
            l.first_name, l.last_name
     FROM quotations q LEFT JOIN leads l ON l.id = q.lead_id
     WHERE q.org_id = ? AND q.valid_until >= ? AND q.valid_until <= ?
       AND q.status IN ('sent','viewed','awaiting_response') ${mine ? 'AND q.owner_id = ?' : ''}`,
    mine ? [orgId, start, end, userId] : [orgId, start, end],
  ).map((q) => ({
    id: q.id, kind: 'quote_deadline' as const, type: 'quote', title: `${q.number} expires`,
    start: q.valid_until, end: q.valid_until, lead_id: q.lead_id,
    subtitle: q.first_name ? `${q.first_name} ${q.last_name}` : q.title,
    owner: null, status: q.status,
  }));

  res.json({ events: [...appointments, ...tasks, ...quoteDeadlines].sort((a, b) => a.start.localeCompare(b.start)) });
}));
