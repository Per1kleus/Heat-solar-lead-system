import { all, get, run } from '../lib/db.ts';
import { nowIso, addDays, addMinutes } from '../lib/time.ts';
import { processDueRuns } from '../lib/automation.ts';
import { emit } from '../lib/events.ts';
import { notify } from '../lib/notify.ts';
import { config } from '../lib/config.ts';
import { audit } from '../lib/audit.ts';
import { money, rescoreLead } from '../lib/leads.ts';

/**
 * One periodic tick drives everything time-based: automation steps that have come
 * due, overdue follow-ups, idle leads, leads without a next action, expiring
 * quotations and tomorrow's appointments. Every sweep is bounded and indexed so
 * it stays cheap with tens of thousands of leads.
 */
export function startScheduler(): { stop: () => void } {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    try {
      processDueRuns();
      sweepOverdueTasks();
      sweepIdleLeads();
      sweepStaleScores();
      sweepLeadsWithoutNextAction();
      sweepExpiringQuotations();
      sweepUpcomingAppointments();
      sweepLostRecovery();
      cleanupIdempotencyKeys();
      applyRetentionDaily();
    } catch (err) {
      console.error('[scheduler] tick failed', err);
    } finally {
      running = false;
    }
  };
  tick();
  const timer = setInterval(tick, config.automationTickMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}

/** Overdue follow-ups: one notification per task, raised once. */
function sweepOverdueTasks(): void {
  const overdue = all<{ id: string; org_id: string; lead_id: string | null; title: string; assignee_id: string | null; due_at: string }>(
    `SELECT id, org_id, lead_id, title, assignee_id, due_at FROM tasks
     WHERE status = 'open' AND due_at IS NOT NULL AND due_at < ?
     ORDER BY due_at LIMIT 300`,
    [nowIso()],
  );
  for (const task of overdue) {
    if (!task.assignee_id) continue;
    const dedupeKey = `overdue:${task.id}`;
    const created = notify({
      orgId: task.org_id, userId: task.assignee_id, type: 'task_overdue', severity: 'critical',
      title: 'Follow-up overdue',
      body: `${task.title} was due ${new Date(task.due_at).toLocaleString('en-GB')}.`,
      link: task.lead_id ? `/leads/${task.lead_id}` : '/tasks',
      leadId: task.lead_id, dedupeKey,
    });
    // Only fire the automation trigger the first time this task goes overdue.
    if (created) emit({ type: 'task_overdue', orgId: task.org_id, taskId: task.id, leadId: task.lead_id });
  }
}

/** Leads that have gone quiet, using each organisation's configured threshold. */
function sweepIdleLeads(): void {
  const orgs = all<{ id: string; stale_lead_hours: number }>('SELECT id, stale_lead_hours FROM organizations');
  for (const org of orgs) {
    const cutoff = addMinutes(new Date(), -Math.max(1, org.stale_lead_hours) * 60);
    const idle = all<{ id: string; first_name: string; last_name: string; owner_id: string | null; estimated_value: number; last_activity_at: string | null }>(
      `SELECT id, first_name, last_name, owner_id, estimated_value, last_activity_at FROM leads
       WHERE org_id = ? AND status = 'open' AND deleted_at IS NULL
         AND (last_activity_at IS NULL OR last_activity_at < ?)
       ORDER BY estimated_value DESC LIMIT 100`,
      [org.id, cutoff],
    );
    for (const lead of idle) {
      // Re-alert at most once a day per lead.
      const bucket = new Date().toISOString().slice(0, 10);
      if (lead.owner_id) {
        notify({
          orgId: org.id, userId: lead.owner_id, type: 'lead_idle', severity: 'warning',
          title: `No activity on ${lead.first_name} ${lead.last_name}`,
          body: `${money(lead.estimated_value)} · nothing recorded for over ${org.stale_lead_hours} hours.`,
          link: `/leads/${lead.id}`, leadId: lead.id,
          dedupeKey: `idle:${lead.id}:${bucket}`,
        });
      }
      emit({ type: 'lead_idle', orgId: org.id, leadId: lead.id });
    }
  }
}

/**
 * Score decay. The staleness and unreachable penalties fire on the ABSENCE of
 * activity, so nothing else would ever recalculate them: a lead nobody touches
 * would keep the score it earned on the day it arrived. This sweep re-scores the
 * open leads with the oldest scores, which is what makes a forgotten hot lead
 * cool down and cross back into the temperature the sales manager should see.
 */
function sweepStaleScores(): void {
  const cutoff = addMinutes(new Date(), -12 * 60);
  const leads = all<{ id: string; org_id: string }>(
    `SELECT id, org_id FROM leads
     WHERE status = 'open' AND deleted_at IS NULL AND (scored_at IS NULL OR scored_at < ?)
     ORDER BY scored_at IS NULL DESC, scored_at
     LIMIT 100`,
    [cutoff],
  );
  for (const lead of leads) {
    try {
      rescoreLead(lead.org_id, lead.id, { touch: false });
    } catch (err) {
      console.error('[scheduler] could not rescore', lead.id, err);
    }
  }
}

/** Rule 8: an active lead with nothing scheduled is flagged. */
function sweepLeadsWithoutNextAction(): void {
  const leads = all<{ id: string; org_id: string; first_name: string; last_name: string; owner_id: string | null; estimated_value: number }>(
    `SELECT id, org_id, first_name, last_name, owner_id, estimated_value FROM leads
     WHERE status = 'open' AND deleted_at IS NULL AND next_action_id IS NULL
     ORDER BY estimated_value DESC LIMIT 200`,
  );
  const bucket = new Date().toISOString().slice(0, 10);
  for (const lead of leads) {
    if (lead.owner_id) {
      notify({
        orgId: lead.org_id, userId: lead.owner_id, type: 'no_next_action', severity: 'warning',
        title: `${lead.first_name} ${lead.last_name} has no next action`,
        body: `${money(lead.estimated_value)} open with nothing scheduled.`,
        link: `/leads/${lead.id}`, leadId: lead.id,
        dedupeKey: `no-next:${lead.id}:${bucket}`,
      });
    }
    emit({ type: 'no_next_action', orgId: lead.org_id, leadId: lead.id });
  }
}

/** Quotations past their validity date expire; the owner is told. */
function sweepExpiringQuotations(): void {
  const expired = all<{ id: string; org_id: string; number: string; owner_id: string | null; total: number; lead_id: string | null; currency: string }>(
    `SELECT id, org_id, number, owner_id, total, lead_id, currency FROM quotations
     WHERE status IN ('sent','viewed','awaiting_response') AND valid_until IS NOT NULL AND valid_until < ?
     LIMIT 200`,
    [nowIso()],
  );
  for (const quote of expired) {
    run("UPDATE quotations SET status = 'expired', updated_at = ? WHERE id = ?", [nowIso(), quote.id]);
    if (quote.owner_id) {
      notify({
        orgId: quote.org_id, userId: quote.owner_id, type: 'quote_stale', severity: 'warning',
        title: `Quotation ${quote.number} has expired`,
        body: `${money(quote.total, quote.currency)} — reissue it or close the lead.`,
        link: `/quotations/${quote.id}`, leadId: quote.lead_id,
        dedupeKey: `expired:${quote.id}`,
      });
    }
  }

  // Quotations sitting unanswered move to "awaiting response" after two days.
  run(
    `UPDATE quotations SET status = 'awaiting_response', updated_at = ?
     WHERE status IN ('sent','viewed') AND sent_at IS NOT NULL AND sent_at < ? AND responded_at IS NULL`,
    [nowIso(), addDays(new Date(), -2)],
  );
}

/** A reminder the evening before each appointment. */
function sweepUpcomingAppointments(): void {
  const upcoming = all<{ id: string; org_id: string; title: string; starts_at: string; assignee_id: string | null; technician_id: string | null; lead_id: string | null; location: string | null }>(
    `SELECT id, org_id, title, starts_at, assignee_id, technician_id, lead_id, location FROM appointments
     WHERE status = 'scheduled' AND starts_at > ? AND starts_at < ? LIMIT 200`,
    [nowIso(), addDays(new Date(), 1)],
  );
  for (const appt of upcoming) {
    for (const userId of [appt.assignee_id, appt.technician_id].filter(Boolean) as string[]) {
      notify({
        orgId: appt.org_id, userId, type: 'appointment_soon', severity: 'info',
        title: `Tomorrow: ${appt.title}`,
        body: `${new Date(appt.starts_at).toLocaleString('en-GB')}${appt.location ? ` · ${appt.location}` : ''}`,
        link: appt.lead_id ? `/leads/${appt.lead_id}` : '/calendar',
        leadId: appt.lead_id, dedupeKey: `appt:${appt.id}:${userId}`,
      });
    }
  }
}

/** Lost leads whose recovery date has arrived get their recovery task. */
function sweepLostRecovery(): void {
  const due = all<{ id: string; org_id: string; owner_id: string | null; first_name: string; last_name: string; recovery_date: string; estimated_value: number }>(
    `SELECT id, org_id, owner_id, first_name, last_name, recovery_date, estimated_value FROM leads
     WHERE status = 'lost' AND deleted_at IS NULL AND recovery_date IS NOT NULL AND recovery_date <= ?
       AND recovered_at IS NULL LIMIT 100`,
    [nowIso()],
  );
  for (const lead of due) {
    if (!lead.owner_id) continue;
    notify({
      orgId: lead.org_id, userId: lead.owner_id, type: 'lead_idle', severity: 'info',
      title: `Recovery due: ${lead.first_name} ${lead.last_name}`,
      body: `${money(lead.estimated_value)} — the customer asked to be contacted again around now.`,
      link: `/leads/${lead.id}`, leadId: lead.id,
      dedupeKey: `recovery:${lead.id}`,
    });
  }
}

/** Idempotency keys only need to outlive a client retry window. */
function cleanupIdempotencyKeys(): void {
  run('DELETE FROM idempotency_keys WHERE created_at < ?', [addDays(new Date(), -2)]);
  run('DELETE FROM rate_limits WHERE window_start < ?', [Date.now() - 24 * 60 * 60 * 1000]);
  run("DELETE FROM sessions WHERE expires_at < ?", [nowIso()]);
  run('DELETE FROM notifications WHERE created_at < ? AND read_at IS NOT NULL', [addDays(new Date(), -60)]);
}

/**
 * Retention is a promise to the people in the database, so it has to actually
 * run — once a day is enough, and a repeat after a restart is harmless because
 * the sweep is idempotent.
 */
let retentionRanOn = '';
function applyRetentionDaily(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (retentionRanOn === today) return;
  retentionRanOn = today;
  const deleted = applyRetention();
  if (deleted > 0) console.log(`[scheduler] retention removed ${deleted} lost lead(s)`);
}

/** Applies each organisation's retention policy (0 = keep indefinitely). */
export function applyRetention(): number {
  const orgs = all<{ id: string; retention_months: number }>(
    'SELECT id, retention_months FROM organizations WHERE retention_months > 0',
  );
  let deleted = 0;
  for (const org of orgs) {
    const cutoff = addDays(new Date(), -org.retention_months * 30);
    const stale = all<{ id: string }>(
      `SELECT id FROM leads WHERE org_id = ? AND status = 'lost' AND lost_at < ? AND deleted_at IS NULL
       AND (recovery_date IS NULL OR recovery_date < ?) LIMIT 500`,
      [org.id, cutoff, nowIso()],
    );
    for (const lead of stale) {
      run('UPDATE leads SET deleted_at = ? WHERE id = ?', [nowIso(), lead.id]);
      deleted += 1;
    }
    if (stale.length > 0) {
      audit({
        orgId: org.id, actorLabel: 'retention policy', action: 'retention.applied',
        entityType: 'lead', entityLabel: `${stale.length} lost lead(s) older than ${org.retention_months} months`,
        changes: { retention_months: org.retention_months, removed: stale.length },
      });
    }
  }
  return deleted;
}

export { get };
