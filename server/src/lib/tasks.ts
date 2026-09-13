import { get, insert, run } from './db.ts';
import { newId } from './ids.ts';
import { nowIso } from './time.ts';
import { logActivity, recomputeNextAction, rescoreLead } from './leads.ts';
import { audit } from './audit.ts';
import { badRequest, notFound } from './errors.ts';

export interface CreateTaskInput {
  orgId: string;
  title: string;
  description?: string | null;
  type?: string;
  leadId?: string | null;
  customerId?: string | null;
  projectId?: string | null;
  quotationId?: string | null;
  appointmentId?: string | null;
  surveyId?: string | null;
  assigneeId?: string | null;
  dueAt?: string | null;
  priority?: 'urgent' | 'high' | 'normal' | 'low';
  isNextAction?: boolean;
  recurrence?: string | null;
  source?: 'manual' | 'automation' | 'sequence' | 'system';
  automationRunId?: string | null;
  /** Set by automation so a retried step cannot create the same task twice. */
  dedupeKey?: string | null;
  createdBy?: string | null;
}

export function createTask(input: CreateTaskInput): any {
  if (!input.title?.trim()) throw badRequest('A task needs a title.');

  if (input.dedupeKey) {
    const existing = get<any>('SELECT * FROM tasks WHERE org_id = ? AND dedupe_key = ?', [input.orgId, input.dedupeKey]);
    if (existing) return existing;
  }

  // Default the assignee to the lead's owner so nothing lands in a void.
  let assigneeId = input.assigneeId ?? null;
  if (!assigneeId && input.leadId) {
    assigneeId = get<{ owner_id: string | null }>(
      'SELECT owner_id FROM leads WHERE id = ? AND org_id = ?', [input.leadId, input.orgId],
    )?.owner_id ?? null;
  }

  const id = newId('tsk');
  const now = nowIso();
  insert('tasks', {
    id,
    org_id: input.orgId,
    lead_id: input.leadId ?? null,
    customer_id: input.customerId ?? null,
    project_id: input.projectId ?? null,
    quotation_id: input.quotationId ?? null,
    appointment_id: input.appointmentId ?? null,
    survey_id: input.surveyId ?? null,
    title: input.title.trim(),
    description: input.description ?? null,
    type: input.type ?? 'follow_up',
    assignee_id: assigneeId,
    due_at: input.dueAt ?? null,
    priority: input.priority ?? 'normal',
    status: 'open',
    is_next_action: input.isNextAction === false ? 0 : 1,
    recurrence: input.recurrence ?? null,
    source: input.source ?? 'manual',
    automation_run_id: input.automationRunId ?? null,
    dedupe_key: input.dedupeKey ?? null,
    created_by: input.createdBy ?? null,
    created_at: now,
    updated_at: now,
  });

  if (input.leadId) {
    logActivity({
      orgId: input.orgId, leadId: input.leadId, type: 'task',
      title: `Task created: ${input.title}`,
      body: input.dueAt ? `Due ${new Date(input.dueAt).toLocaleString('en-GB')}` : 'No due date',
      meta: { task_id: id, source: input.source ?? 'manual' },
      userId: input.createdBy ?? null,
    });
    recomputeNextAction(input.orgId, input.leadId);
  }
  return get<any>('SELECT * FROM tasks WHERE id = ?', [id]);
}

export function completeTask(
  orgId: string, taskId: string, userId: string | null, outcomeNote?: string | null,
): any {
  const task = get<any>('SELECT * FROM tasks WHERE id = ? AND org_id = ?', [taskId, orgId]);
  if (!task) throw notFound('That task no longer exists.');
  if (task.status === 'done') return task;
  const now = nowIso();
  run(
    `UPDATE tasks SET status = 'done', completed_at = ?, completed_by = ?, outcome_note = ?, updated_at = ?
     WHERE id = ? AND org_id = ?`,
    [now, userId, outcomeNote ?? null, now, taskId, orgId],
  );
  if (task.lead_id) {
    logActivity({
      orgId, leadId: task.lead_id, type: 'task',
      title: `Task completed: ${task.title}`,
      body: outcomeNote ?? null, meta: { task_id: taskId }, userId,
    });
    recomputeNextAction(orgId, task.lead_id);
    rescoreLead(orgId, task.lead_id);
  }
  if (task.recurrence) scheduleRecurrence(orgId, task, userId);
  audit({
    orgId, userId, action: 'task.completed', entityType: 'task', entityId: taskId, entityLabel: task.title,
  });
  return get<any>('SELECT * FROM tasks WHERE id = ?', [taskId]);
}

function scheduleRecurrence(orgId: string, task: any, userId: string | null): void {
  const base = task.due_at ? new Date(task.due_at) : new Date();
  const next = new Date(base);
  if (task.recurrence === 'daily') next.setDate(next.getDate() + 1);
  else if (task.recurrence === 'weekly') next.setDate(next.getDate() + 7);
  else if (task.recurrence === 'monthly') next.setMonth(next.getMonth() + 1);
  else return;
  createTask({
    orgId, title: task.title, description: task.description, type: task.type,
    leadId: task.lead_id, customerId: task.customer_id, projectId: task.project_id,
    assigneeId: task.assignee_id, dueAt: next.toISOString(), priority: task.priority,
    recurrence: task.recurrence, source: 'system', createdBy: userId,
  });
}

export function rescheduleTask(orgId: string, taskId: string, dueAt: string, userId: string | null): any {
  const task = get<any>('SELECT * FROM tasks WHERE id = ? AND org_id = ?', [taskId, orgId]);
  if (!task) throw notFound('That task no longer exists.');
  run('UPDATE tasks SET due_at = ?, updated_at = ? WHERE id = ? AND org_id = ?', [dueAt, nowIso(), taskId, orgId]);
  if (task.lead_id) {
    logActivity({
      orgId, leadId: task.lead_id, type: 'task',
      title: `Task rescheduled: ${task.title}`,
      body: `Now due ${new Date(dueAt).toLocaleString('en-GB')}`,
      meta: { task_id: taskId }, userId,
    });
    recomputeNextAction(orgId, task.lead_id);
  }
  return get<any>('SELECT * FROM tasks WHERE id = ?', [taskId]);
}
