import { Router } from 'express';
import { z } from 'zod';
import { all, get, insert, parseJson, run } from '../lib/db.ts';
import { ah } from '../middleware/errors.ts';
import { requirePermission } from '../middleware/context.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { audit } from '../lib/audit.ts';
import { requireFeature } from '../lib/billing.ts';

export const automationsRouter = Router();

export const TRIGGERS = [
  { key: 'lead_created', label: 'A new lead is created', config: [] },
  { key: 'stage_changed', label: 'A lead enters a pipeline stage', config: [{ key: 'stage', label: 'Stage', type: 'stage' }] },
  { key: 'temperature_changed', label: 'A lead changes temperature', config: [{ key: 'to', label: 'Becomes', type: 'select', options: ['hot', 'warm', 'cold'] }] },
  { key: 'quote_sent', label: 'A quotation is sent', config: [] },
  { key: 'lead_won', label: 'A deal is won', config: [] },
  { key: 'lead_lost', label: 'A lead is marked lost', config: [] },
  { key: 'task_overdue', label: 'A follow-up becomes overdue', config: [] },
  { key: 'lead_idle', label: 'A lead has had no activity', config: [{ key: 'hours', label: 'Hours without activity', type: 'number' }] },
  { key: 'no_next_action', label: 'An open lead has no next action', config: [] },
  { key: 'appointment_scheduled', label: 'An appointment is scheduled', config: [] },
];

export const ACTIONS = [
  { key: 'create_task', label: 'Create a follow-up task', fields: ['title', 'task_type', 'priority', 'due_in_minutes', 'description'] },
  { key: 'notify_owner', label: 'Notify the lead owner', fields: ['title', 'body', 'severity', 'notification_type'] },
  { key: 'notify_assignee', label: 'Notify the task assignee', fields: ['title', 'body', 'severity'] },
  { key: 'notify_managers', label: 'Notify sales managers', fields: ['title', 'body', 'severity'] },
  { key: 'send_template', label: 'Send a message template', fields: ['template_key', 'channel', 'purpose'] },
  { key: 'change_stage', label: 'Move the lead to a stage', fields: ['stage_key'] },
  { key: 'add_tag', label: 'Add a tag', fields: ['tag'] },
  { key: 'schedule_recovery', label: 'Schedule the lost-lead recovery task', fields: [] },
  { key: 'stop_sales_automations', label: 'Stop active sales sequences and create the customer', fields: [] },
];

export const STOP_CONDITIONS = [
  { key: 'contacted', label: 'The salesperson has contacted the lead' },
  { key: 'customer_replied', label: 'The customer replied' },
  { key: 'appointment_booked', label: 'An appointment was booked' },
  { key: 'quote_responded', label: 'The customer answered the quotation' },
  { key: 'won', label: 'The deal was won' },
  { key: 'lost', label: 'The lead was lost' },
  { key: 'paused', label: 'Automation was paused on the lead' },
];

automationsRouter.get('/', requirePermission('automation:read'), ah((req, res) => {
  const rules = all<any>(
    `SELECT r.*, (SELECT COUNT(*) FROM automation_runs ar WHERE ar.rule_id = r.id AND ar.status = 'active') AS active_runs
     FROM automation_rules r WHERE r.org_id = ? ORDER BY r.is_system DESC, r.created_at`,
    [req.ctx.orgId],
  );
  res.json({
    rules: rules.map(shapeRule),
    triggers: TRIGGERS,
    actions: ACTIONS,
    stop_conditions: STOP_CONDITIONS,
    templates: all('SELECT key, name, channel FROM message_templates WHERE org_id = ? AND is_active = 1', [req.ctx.orgId]),
    stages: all('SELECT key, name FROM pipeline_stages WHERE org_id = ? AND is_active = 1 ORDER BY position', [req.ctx.orgId]),
  });
}));

automationsRouter.get('/:id', requirePermission('automation:read'), ah((req, res) => {
  const rule = get<any>('SELECT * FROM automation_rules WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]);
  if (!rule) throw notFound('That automation no longer exists.');
  res.json({
    rule: shapeRule(rule),
    runs: all<any>(
      `SELECT r.*, l.first_name, l.last_name FROM automation_runs r
       LEFT JOIN leads l ON l.id = r.lead_id
       WHERE r.rule_id = ? AND r.org_id = ? ORDER BY r.started_at DESC LIMIT 50`,
      [rule.id, req.ctx.orgId],
    ).map((r) => ({ ...r, log: parseJson(r.log, []), context: parseJson(r.context, {}) })),
  });
}));

const stepSchema = z.object({
  delay_minutes: z.number().int().min(0).max(60 * 24 * 365),
  stop_if: z.array(z.string()).optional(),
  actions: z.array(z.object({ type: z.string() }).passthrough()).min(1, 'Each step needs at least one action.'),
});

const ruleSchema = z.object({
  name: z.string().min(1, 'Give the automation a name.'),
  description: z.string().nullish(),
  trigger_type: z.string().min(1),
  trigger_config: z.record(z.any()).default({}),
  conditions: z.array(z.object({ field: z.string(), op: z.string(), value: z.any() })).default([]),
  steps: z.array(stepSchema).min(1, 'Add at least one step.'),
  stop_on: z.array(z.string()).default([]),
  is_active: z.boolean().default(true),
});

automationsRouter.post('/', requirePermission('automation:write'), ah((req, res) => {
  requireFeature(req.ctx.orgId, 'automation_advanced', 'Custom automation');
  const body = ruleSchema.parse(req.body);
  validateRule(body);
  const id = newId('aut');
  const now = nowIso();
  insert('automation_rules', {
    id, org_id: req.ctx.orgId, name: body.name, description: body.description ?? null,
    trigger_type: body.trigger_type, trigger_config: JSON.stringify(body.trigger_config),
    conditions: JSON.stringify(body.conditions), steps: JSON.stringify(body.steps),
    stop_on: JSON.stringify(body.stop_on), is_active: body.is_active ? 1 : 0,
    created_by: req.ctx.user.id, created_at: now, updated_at: now,
  });
  audit({
    orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'automation.created', entityType: 'automation_rule',
    entityId: id, entityLabel: body.name,
  });
  res.status(201).json({ rule: shapeRule(get('SELECT * FROM automation_rules WHERE id = ?', [id])) });
}));

automationsRouter.patch('/:id', requirePermission('automation:write'), ah((req, res) => {
  const rule = get<any>('SELECT * FROM automation_rules WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]);
  if (!rule) throw notFound('That automation no longer exists.');
  const body = ruleSchema.partial().parse(req.body);
  if (body.steps || body.trigger_type) {
    validateRule({
      trigger_type: body.trigger_type ?? rule.trigger_type,
      steps: body.steps ?? parseJson(rule.steps, []),
    });
  }
  const map: Record<string, any> = { name: body.name, description: body.description, trigger_type: body.trigger_type };
  if (body.trigger_config) map.trigger_config = JSON.stringify(body.trigger_config);
  if (body.conditions) map.conditions = JSON.stringify(body.conditions);
  if (body.steps) map.steps = JSON.stringify(body.steps);
  if (body.stop_on) map.stop_on = JSON.stringify(body.stop_on);
  if (body.is_active !== undefined) map.is_active = body.is_active ? 1 : 0;
  const keys = Object.keys(map).filter((k) => map[k] !== undefined);
  if (keys.length === 0) throw badRequest('Nothing to update.');
  run(
    `UPDATE automation_rules SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND org_id = ?`,
    [...keys.map((k) => map[k]), nowIso(), rule.id, req.ctx.orgId],
  );
  audit({
    orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'automation.updated', entityType: 'automation_rule',
    entityId: rule.id, entityLabel: rule.name, changes: map,
  });
  res.json({ rule: shapeRule(get('SELECT * FROM automation_rules WHERE id = ?', [rule.id])) });
}));

automationsRouter.delete('/:id', requirePermission('automation:write'), ah((req, res) => {
  const rule = get<any>('SELECT * FROM automation_rules WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]);
  if (!rule) throw notFound('That automation no longer exists.');
  if (rule.is_system) {
    run('UPDATE automation_rules SET is_active = 0, updated_at = ? WHERE id = ?', [nowIso(), rule.id]);
    return res.json({ ok: true, deactivated: true, message: 'Built-in automations are switched off rather than deleted.' });
  }
  run('DELETE FROM automation_rules WHERE id = ? AND org_id = ?', [rule.id, req.ctx.orgId]);
  audit({
    orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'automation.deleted', entityType: 'automation_rule',
    entityId: rule.id, entityLabel: rule.name,
  });
  res.json({ ok: true, deactivated: false });
}));

automationsRouter.get('/:id/runs', requirePermission('automation:read'), ah((req, res) => {
  res.json({
    runs: all<any>(
      `SELECT r.*, l.first_name, l.last_name, l.reference FROM automation_runs r
       LEFT JOIN leads l ON l.id = r.lead_id
       WHERE r.rule_id = ? AND r.org_id = ? ORDER BY r.started_at DESC LIMIT 100`,
      [req.params.id, req.ctx.orgId],
    ).map((r) => ({ ...r, log: parseJson(r.log, []) })),
  });
}));

function shapeRule(rule: any): any {
  return {
    ...rule,
    trigger_config: parseJson(rule.trigger_config, {}),
    conditions: parseJson(rule.conditions, []),
    steps: parseJson(rule.steps, []),
    stop_on: parseJson(rule.stop_on, []),
    is_active: !!rule.is_active,
    is_system: !!rule.is_system,
  };
}

function validateRule(rule: { trigger_type: string; steps: any[] }): void {
  if (!TRIGGERS.some((t) => t.key === rule.trigger_type)) {
    throw badRequest(`"${rule.trigger_type}" is not a trigger this system understands.`);
  }
  const known = new Set(ACTIONS.map((a) => a.key));
  for (const step of rule.steps) {
    for (const action of step.actions ?? []) {
      if (!known.has(action.type)) throw badRequest(`"${action.type}" is not an action this system can run.`);
      if (action.type === 'create_task' && !action.title) throw badRequest('A "create task" action needs a title.');
      if (action.type === 'send_template' && !action.template_key) {
        throw badRequest('A "send template" action needs a template.');
      }
      if (action.type === 'change_stage' && !action.stage_key) throw badRequest('A "move stage" action needs a stage.');
    }
  }
}
