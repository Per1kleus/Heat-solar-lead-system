import { all, get, insert, parseJson, run } from './db.ts';
import { newId } from './ids.ts';
import { addMinutes, nowIso } from './time.ts';
import { onDomainEvent, type DomainEvent } from './events.ts';
import {
  loadLead, logActivity, matchCondition, recomputeNextAction, shapeLead,
  ensureCustomerForLead, userName,
} from './leads.ts';
import { createTask } from './tasks.ts';
import { notify, notifyManagers, type NotificationType } from './notify.ts';
import { render } from './render.ts';
import { sendTemplate } from './messaging.ts';

export interface AutomationStep {
  delay_minutes: number;
  actions: AutomationAction[];
  /** Conditions that skip the remaining steps, e.g. `contacted`. */
  stop_if?: string[];
}

export interface AutomationAction {
  type: string;
  [key: string]: any;
}

interface RuleRow {
  id: string; org_id: string; key: string | null; name: string; trigger_type: string;
  trigger_config: string; conditions: string; steps: string; stop_on: string; is_active: number;
}

// --- trigger handling -----------------------------------------------------

export function registerAutomationEngine(): void {
  onDomainEvent(handleEvent);
}

function handleEvent(event: DomainEvent): void {
  switch (event.type) {
    case 'lead_created':
      startRules(event.orgId, 'lead_created', { leadId: event.leadId });
      break;
    case 'stage_changed':
      startRules(event.orgId, 'stage_changed', { leadId: event.leadId }, (cfg) =>
        !cfg.stage || cfg.stage === event.toStage);
      break;
    case 'temperature_changed':
      startRules(event.orgId, 'temperature_changed', { leadId: event.leadId }, (cfg) =>
        !cfg.to || cfg.to === event.to);
      break;
    case 'quote_sent':
      startRules(event.orgId, 'quote_sent', { leadId: event.leadId, quotationId: event.quotationId });
      break;
    case 'lead_won':
      stopRuns(event.orgId, event.leadId, 'won');
      startRules(event.orgId, 'lead_won', { leadId: event.leadId });
      break;
    case 'lead_lost':
      stopRuns(event.orgId, event.leadId, 'lost');
      startRules(event.orgId, 'lead_lost', { leadId: event.leadId });
      break;
    case 'customer_replied':
      stopRuns(event.orgId, event.leadId, 'customer_replied');
      break;
    case 'lead_contacted':
      markContacted(event.orgId, event.leadId);
      break;
    case 'appointment_booked':
      if (event.leadId) stopRuns(event.orgId, event.leadId, 'appointment_booked');
      break;
    case 'quote_responded':
      if (event.leadId) stopRuns(event.orgId, event.leadId, 'quote_responded', event.quotationId);
      break;
    case 'task_overdue':
      startRules(event.orgId, 'task_overdue', { leadId: event.leadId, taskId: event.taskId });
      break;
    case 'lead_idle':
      startRules(event.orgId, 'lead_idle', { leadId: event.leadId });
      break;
    case 'no_next_action':
      startRules(event.orgId, 'no_next_action', { leadId: event.leadId });
      break;
    default:
      break;
  }
}

/**
 * Enrol a lead (and optionally a quotation) into every active rule for a trigger.
 * One run per (rule, lead, quotation) — the unique index makes re-enrolment a no-op.
 */
function startRules(
  orgId: string,
  triggerType: string,
  target: { leadId: string | null; quotationId?: string; taskId?: string },
  configFilter?: (config: Record<string, any>) => boolean,
): void {
  const rules = all<RuleRow>(
    'SELECT * FROM automation_rules WHERE org_id = ? AND trigger_type = ? AND is_active = 1',
    [orgId, triggerType],
  );
  if (rules.length === 0) return;

  const lead = target.leadId ? safeLoadLead(orgId, target.leadId) : null;
  if (lead && lead.automation_paused) return;

  for (const rule of rules) {
    const config = parseJson<Record<string, any>>(rule.trigger_config, {});
    if (configFilter && !configFilter(config)) continue;
    const conditions = parseJson<{ field: string; op: string; value: any }[]>(rule.conditions, []);
    if (lead && conditions.length > 0 && !conditions.every((c) => matchCondition(lead, c))) continue;

    const runId = newId('run');
    const context = {
      lead_id: target.leadId, quotation_id: target.quotationId ?? null, task_id: target.taskId ?? null,
    };
    try {
      insert('automation_runs', {
        id: runId,
        org_id: orgId,
        rule_id: rule.id,
        lead_id: target.leadId,
        quotation_id: target.quotationId ?? null,
        status: 'active',
        step_index: 0,
        next_run_at: nowIso(),
        context: JSON.stringify(context),
        log: '[]',
        started_at: nowIso(),
      });
    } catch {
      // Already enrolled in this rule for this lead/quote.
      continue;
    }
    run('UPDATE automation_rules SET run_count = run_count + 1, last_run_at = ? WHERE id = ?', [nowIso(), rule.id]);
    executeDueSteps(runId);
  }
}

function safeLoadLead(orgId: string, leadId: string): any | null {
  try { return shapeLead(loadLead(orgId, leadId)); } catch { return null; }
}

// --- run execution --------------------------------------------------------

/** Processes every automation run whose next step is due. Called by the scheduler. */
export function processDueRuns(limit = 200): number {
  const due = all<{ id: string }>(
    "SELECT id FROM automation_runs WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT ?",
    [nowIso(), limit],
  );
  let processed = 0;
  for (const row of due) {
    try {
      executeDueSteps(row.id);
      processed += 1;
    } catch (err) {
      run("UPDATE automation_runs SET status = 'failed', error = ?, completed_at = ? WHERE id = ?", [
        err instanceof Error ? err.message : String(err), nowIso(), row.id,
      ]);
      console.error('[automation] run failed', row.id, err);
    }
  }
  return processed;
}

export function executeDueSteps(runId: string): void {
  // A run may have several zero-delay steps; loop until one is scheduled for later.
  for (let guard = 0; guard < 25; guard += 1) {
    const runRow = get<any>('SELECT * FROM automation_runs WHERE id = ?', [runId]);
    if (!runRow || runRow.status !== 'active') return;
    if (runRow.next_run_at && new Date(runRow.next_run_at) > new Date()) return;

    const rule = get<RuleRow>('SELECT * FROM automation_rules WHERE id = ?', [runRow.rule_id]);
    if (!rule || !rule.is_active) {
      finishRun(runId, 'stopped', 'rule_disabled');
      return;
    }
    const steps = parseJson<AutomationStep[]>(rule.steps, []);
    const step = steps[runRow.step_index];
    if (!step) {
      finishRun(runId, 'completed', null);
      return;
    }

    const ctx = buildContext(runRow);
    if (!ctx) {
      finishRun(runId, 'stopped', 'target_missing');
      return;
    }
    if (ctx.lead?.automation_paused) {
      finishRun(runId, 'stopped', 'paused');
      return;
    }
    if (step.stop_if && shouldStop(step.stop_if, ctx)) {
      finishRun(runId, 'stopped', step.stop_if.join(','));
      return;
    }

    const logEntries: string[] = [];
    for (const action of step.actions ?? []) {
      try {
        const message = runAction(action, ctx, rule, runRow);
        if (message) logEntries.push(message);
      } catch (err) {
        logEntries.push(`${action.type}: failed - ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const nextIndex = runRow.step_index + 1;
    const nextStep = steps[nextIndex];
    const log = parseJson<any[]>(runRow.log, []);
    log.push({ step: runRow.step_index, at: nowIso(), entries: logEntries });

    if (!nextStep) {
      run(
        "UPDATE automation_runs SET status = 'completed', step_index = ?, next_run_at = NULL, log = ?, completed_at = ? WHERE id = ?",
        [nextIndex, JSON.stringify(log), nowIso(), runId],
      );
      return;
    }
    run('UPDATE automation_runs SET step_index = ?, next_run_at = ?, log = ? WHERE id = ?', [
      nextIndex, addMinutes(new Date(), nextStep.delay_minutes ?? 0), JSON.stringify(log), runId,
    ]);
    if ((nextStep.delay_minutes ?? 0) > 0) return;
  }
}

/** Appends a line to a run's log without disturbing its scheduling. */
function appendRunLog(runId: string, entry: string): void {
  const row = get<{ log: string }>('SELECT log FROM automation_runs WHERE id = ?', [runId]);
  if (!row) return;
  const log = parseJson<any[]>(row.log, []);
  log.push({ at: nowIso(), entries: [entry] });
  run('UPDATE automation_runs SET log = ? WHERE id = ?', [JSON.stringify(log), runId]);
}

function finishRun(runId: string, status: 'completed' | 'stopped', reason: string | null): void {
  run('UPDATE automation_runs SET status = ?, stopped_reason = ?, next_run_at = NULL, completed_at = ? WHERE id = ?', [
    status, reason, nowIso(), runId,
  ]);
}

interface ActionContext {
  orgId: string;
  lead: any | null;
  quotation: any | null;
  task: any | null;
  org: any;
}

function buildContext(runRow: any): ActionContext | null {
  const ctx = parseJson<Record<string, any>>(runRow.context, {});
  const org = get<any>('SELECT * FROM organizations WHERE id = ?', [runRow.org_id]);
  if (!org) return null;
  const lead = runRow.lead_id ? safeLoadLead(runRow.org_id, runRow.lead_id) : null;
  if (runRow.lead_id && !lead) return null;
  const quotation = runRow.quotation_id
    ? get<any>('SELECT * FROM quotations WHERE id = ? AND org_id = ?', [runRow.quotation_id, runRow.org_id]) ?? null
    : null;
  const task = ctx.task_id
    ? get<any>('SELECT * FROM tasks WHERE id = ? AND org_id = ?', [ctx.task_id, runRow.org_id]) ?? null
    : null;
  return { orgId: runRow.org_id, lead, quotation, task, org };
}

/** Conditions that cut a sequence short. */
function shouldStop(conditions: string[], ctx: ActionContext): boolean {
  for (const condition of conditions) {
    switch (condition) {
      case 'contacted':
        if (ctx.lead?.first_contacted_at) return true;
        break;
      case 'customer_replied': {
        const reply = get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM activities WHERE org_id = ? AND lead_id = ? AND direction = 'inbound' AND is_customer_touch = 1",
          [ctx.orgId, ctx.lead?.id],
        );
        if ((reply?.n ?? 0) > 0) return true;
        break;
      }
      case 'won':
        if (ctx.lead?.status === 'won') return true;
        break;
      case 'lost':
        if (ctx.lead?.status === 'lost') return true;
        break;
      case 'quote_responded':
        if (ctx.quotation && ['accepted', 'rejected', 'cancelled'].includes(ctx.quotation.status)) return true;
        break;
      case 'appointment_booked': {
        const appt = get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM appointments WHERE org_id = ? AND lead_id = ? AND status = 'scheduled'",
          [ctx.orgId, ctx.lead?.id],
        );
        if ((appt?.n ?? 0) > 0) return true;
        break;
      }
      case 'paused':
        if (ctx.lead?.automation_paused) return true;
        break;
      default:
        break;
    }
  }
  return false;
}

// --- actions --------------------------------------------------------------

function runAction(action: AutomationAction, ctx: ActionContext, rule: RuleRow, runRow: any): string | null {
  switch (action.type) {
    case 'create_task': {
      if (!ctx.lead) return 'create_task: skipped (no lead)';
      const dueAt = addMinutes(new Date(), Number(action.due_in_minutes ?? 0) || 60);
      const task = createTask({
        orgId: ctx.orgId,
        title: render(action.title ?? 'Follow up', ctx),
        description: action.description ? render(action.description, ctx) : `Created by automation: ${rule.name}`,
        type: action.task_type ?? 'follow_up',
        leadId: ctx.lead.id,
        quotationId: ctx.quotation?.id ?? null,
        assigneeId: action.assignee_id ?? ctx.lead.owner_id ?? null,
        dueAt,
        priority: action.priority ?? 'normal',
        source: 'automation',
        automationRunId: runRow.id,
        dedupeKey: `${runRow.id}:${runRow.step_index}:task`,
      });
      return `created task "${task.title}"`;
    }
    case 'notify_owner': {
      const userId = ctx.lead?.owner_id ?? null;
      if (!userId) return 'notify_owner: skipped (lead unassigned)';
      notify({
        orgId: ctx.orgId, userId,
        type: (action.notification_type ?? 'automation') as NotificationType,
        severity: action.severity ?? 'info',
        title: render(action.title ?? rule.name, ctx),
        body: action.body ? render(action.body, ctx) : undefined,
        link: ctx.lead ? `/leads/${ctx.lead.id}` : undefined,
        leadId: ctx.lead?.id ?? null,
        dedupeKey: `${runRow.id}:${runRow.step_index}:notify`,
      });
      return `notified ${userName(ctx.orgId, userId)}`;
    }
    case 'notify_assignee': {
      const userId = ctx.task?.assignee_id ?? ctx.lead?.owner_id ?? null;
      if (!userId) return 'notify_assignee: skipped (no assignee)';
      notify({
        orgId: ctx.orgId, userId,
        type: (action.notification_type ?? 'automation') as NotificationType,
        severity: action.severity ?? 'warning',
        title: render(action.title ?? rule.name, ctx),
        body: action.body ? render(action.body, ctx) : undefined,
        link: ctx.lead ? `/leads/${ctx.lead.id}` : '/tasks',
        leadId: ctx.lead?.id ?? null,
        dedupeKey: `${runRow.id}:${runRow.step_index}:notify`,
      });
      return 'assignee notified';
    }
    case 'notify_managers': {
      notifyManagers(ctx.orgId, {
        type: (action.notification_type ?? 'automation') as NotificationType,
        severity: action.severity ?? 'info',
        title: render(action.title ?? rule.name, ctx),
        body: action.body ? render(action.body, ctx) : undefined,
        link: ctx.lead ? `/leads/${ctx.lead.id}` : undefined,
        leadId: ctx.lead?.id ?? null,
        dedupeKey: `${runRow.id}:${runRow.step_index}:mgr`,
      });
      return 'managers notified';
    }
    case 'send_template': {
      if (!ctx.lead) return 'send_template: skipped (no lead)';
      // Delivery is asynchronous; the real outcome is appended to this run's log
      // when the provider answers, so the log never claims an unconfirmed send.
      void sendTemplate({
        orgId: ctx.orgId,
        templateKey: action.template_key,
        channel: action.channel ?? 'email',
        leadId: ctx.lead.id,
        quotationId: ctx.quotation?.id ?? null,
        userId: null,
        automationRunId: runRow.id,
        purpose: action.purpose ?? 'operational',
      }).then((result) => {
        appendRunLog(
          runRow.id,
          result.sent
            ? `sent ${action.channel ?? 'email'} template "${action.template_key}"`
            : `template "${action.template_key}" not sent: ${result.reason}`,
        );
      }).catch((err) => {
        appendRunLog(runRow.id, `template "${action.template_key}" failed: ${err?.message ?? err}`);
      });
      return `queued ${action.channel ?? 'email'} template "${action.template_key}"`;
    }
    case 'change_stage': {
      if (!ctx.lead) return 'change_stage: skipped';
      const stage = get<{ id: string; name: string; probability: number }>(
        'SELECT id, name, probability FROM pipeline_stages WHERE org_id = ? AND key = ?',
        [ctx.orgId, action.stage_key],
      );
      if (!stage) return `change_stage: unknown stage ${action.stage_key}`;
      run('UPDATE leads SET stage_id = ?, stage_entered_at = ?, probability = ? WHERE id = ? AND org_id = ?', [
        stage.id, nowIso(), stage.probability, ctx.lead.id, ctx.orgId,
      ]);
      logActivity({
        orgId: ctx.orgId, leadId: ctx.lead.id, type: 'stage_change',
        title: `Automation moved the lead to ${stage.name}`, meta: { rule: rule.name },
      });
      return `moved to ${stage.name}`;
    }
    case 'add_tag': {
      if (!ctx.lead) return 'add_tag: skipped';
      let tag = get<{ id: string }>('SELECT id FROM tags WHERE org_id = ? AND name = ?', [ctx.orgId, action.tag]);
      if (!tag) {
        const id = newId('tag');
        insert('tags', { id, org_id: ctx.orgId, name: action.tag, created_at: nowIso() });
        tag = { id };
      }
      run('INSERT OR IGNORE INTO lead_tags (org_id, lead_id, tag_id) VALUES (?, ?, ?)', [
        ctx.orgId, ctx.lead.id, tag.id,
      ]);
      return `tagged "${action.tag}"`;
    }
    case 'schedule_recovery': {
      if (!ctx.lead?.recovery_date) return 'schedule_recovery: no recovery date set';
      createTask({
        orgId: ctx.orgId,
        title: `Recovery: re-contact ${ctx.lead.full_name}`,
        description: `Lead was lost (${ctx.lead.lost_reason_name ?? 'reason not recorded'}). ${ctx.lead.lost_notes ?? ''}`.trim(),
        type: 'follow_up',
        leadId: ctx.lead.id,
        assigneeId: ctx.lead.owner_id,
        dueAt: new Date(ctx.lead.recovery_date).toISOString(),
        priority: 'normal',
        source: 'automation',
        automationRunId: runRow.id,
        dedupeKey: `recovery:${ctx.lead.id}:${ctx.lead.recovery_date}`,
        isNextAction: false,
      });
      return `recovery task scheduled for ${new Date(ctx.lead.recovery_date).toLocaleDateString('en-GB')}`;
    }
    case 'stop_sales_automations': {
      if (!ctx.lead) return 'stop_sales_automations: skipped';
      const stopped = stopRuns(ctx.orgId, ctx.lead.id, 'won', undefined, runRow.id);
      ensureCustomerForLead(ctx.orgId, ctx.lead.id, null);
      return `stopped ${stopped} active sequence(s) and created the customer record`;
    }
    default:
      return `unknown action "${action.type}"`;
  }
}

export function stopRuns(
  orgId: string, leadId: string, reason: string, quotationId?: string, exceptRunId?: string,
): number {
  const runs = all<{ id: string; rule_id: string }>(
    "SELECT id, rule_id FROM automation_runs WHERE org_id = ? AND lead_id = ? AND status = 'active'",
    [orgId, leadId],
  );
  let stopped = 0;
  for (const r of runs) {
    if (exceptRunId && r.id === exceptRunId) continue;
    const rule = get<RuleRow>('SELECT * FROM automation_rules WHERE id = ?', [r.rule_id]);
    if (!rule) continue;
    const stopOn = parseJson<string[]>(rule.stop_on, []);
    if (!stopOn.includes(reason)) continue;
    if (quotationId) {
      const runRow = get<{ quotation_id: string | null }>('SELECT quotation_id FROM automation_runs WHERE id = ?', [r.id]);
      if (runRow?.quotation_id && runRow.quotation_id !== quotationId) continue;
    }
    finishRun(r.id, 'stopped', reason);
    stopped += 1;
  }
  return stopped;
}

function markContacted(orgId: string, leadId: string): void {
  // Sequences that stop on "contacted" are evaluated on their next tick;
  // nothing to do here beyond keeping the lead's next action accurate.
  recomputeNextAction(orgId, leadId);
}
