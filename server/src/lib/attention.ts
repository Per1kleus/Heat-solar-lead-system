import { all, get } from './db.ts';
import { money } from './leads.ts';
import { addDays, nowIso, startOfDay } from './time.ts';

/**
 * The dashboard's answer to "what should I do right now to sell more?".
 *
 * One flat, ranked list rather than a wall of charts: each entry names the
 * customer, why it is on the list, what to do about it, and carries the ids the
 * UI needs to do that thing without leaving the dashboard. Everything here is
 * derived from data the CRM already keeps — the existing lead score, pipeline
 * stage, next-action date, quotation status, survey status and appointment
 * status. There is deliberately no second scoring system.
 */

export type AttentionAction =
  | 'contact'        // open the message composer for this lead
  | 'follow_up'      // chase a quotation
  | 'create_quote'   // build a quotation from a completed survey
  | 'view_appointment'
  | 'close_appointment'
  | 'schedule'       // give the lead a next action
  | 'schedule_installation'
  | 'assign'
  | 'open';

export interface AttentionItem {
  id: string;
  kind: string;
  /** 1 = do it today, 2 = this week, 3 = when there is time. */
  priority: 1 | 2 | 3;
  name: string;
  reason: string;
  context: string | null;
  value: number | null;
  due_at: string | null;
  action: AttentionAction;
  action_label: string;
  link: string;
  lead_id: string | null;
  /** The existing lead temperature and score — never a second scoring system. */
  temperature?: string | null;
  score?: number | null;
  /** The template the composer should open with, when there is an obvious one. */
  template_key?: string | null;
  /** What an enabled sequence has scheduled next for this lead, if anything. */
  next_automated_at?: string | null;
  quotation_id?: string | null;
  appointment_id?: string | null;
  survey_id?: string | null;
  task_id?: string | null;
  project_id?: string | null;
}

export interface AttentionScope {
  orgId: string;
  userId: string;
  seesAll: boolean;
  staleHours: number;
}

const LIMIT_PER_KIND = 25;

export function buildAttentionList(scope: AttentionScope): AttentionItem[] {
  const { orgId, userId, seesAll, staleHours } = scope;
  const mine = !seesAll;
  const now = nowIso();
  const ownerParam = mine ? [userId] : [];
  const leadOwner = mine ? 'AND l.owner_id = ?' : '';
  const staleCutoff = new Date(Date.now() - staleHours * 3600_000).toISOString();
  const items: AttentionItem[] = [];

  const name = (row: any) => `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || 'Unnamed contact';

  // --- 1. Overdue follow-ups. The promise the business already made.
  for (const task of all<any>(
    `SELECT t.id, t.title, t.due_at, t.priority, t.lead_id, t.type, t.quotation_id,
            l.first_name, l.last_name, l.estimated_value, l.temperature, l.score
     FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id
     WHERE t.org_id = ? AND t.status = 'open' AND t.due_at < ? ${mine ? 'AND t.assignee_id = ?' : ''}
     ORDER BY t.due_at LIMIT ?`,
    [orgId, now, ...ownerParam, LIMIT_PER_KIND],
  )) {
    const overdueBy = daysBetween(task.due_at);
    items.push({
      id: `task:${task.id}`, kind: 'overdue_task', priority: 1,
      name: task.lead_id ? name(task) : task.title,
      reason: `${temperatureWord(task.temperature)}follow-up overdue by ${plural(overdueBy, 'day')}`,
      context: `${task.title} · was due ${relativeDays(task.due_at)}`,
      value: task.estimated_value ?? null,
      due_at: task.due_at,
      temperature: task.temperature ?? null, score: task.score ?? null,
      action: task.lead_id ? 'contact' : 'open',
      action_label: task.type === 'call' ? 'Call now' : 'Contact customer',
      // A task hanging off a quotation is a quotation chase, so open that template.
      template_key: task.quotation_id ? 'quote_follow_up' : undefined,
      link: task.lead_id ? `/app/leads/${task.lead_id}` : '/app/tasks',
      lead_id: task.lead_id, task_id: task.id, quotation_id: task.quotation_id ?? null,
    });
  }

  // --- 2. Missed appointments: a visit that quietly passed loses the sale.
  for (const appt of all<any>(
    `SELECT a.id, a.title, a.starts_at, a.type, a.lead_id, l.first_name, l.last_name, l.estimated_value
     FROM appointments a LEFT JOIN leads l ON l.id = a.lead_id
     WHERE a.org_id = ? AND a.status = 'scheduled' AND a.ends_at < ?
       ${mine ? 'AND (a.assignee_id = ? OR a.technician_id = ?)' : ''}
     ORDER BY a.starts_at DESC LIMIT ?`,
    mine ? [orgId, now, userId, userId, LIMIT_PER_KIND] : [orgId, now, LIMIT_PER_KIND],
  )) {
    items.push({
      id: `appt-missed:${appt.id}`, kind: 'appointment_missed', priority: 1,
      name: appt.lead_id ? name(appt) : appt.title,
      reason: `${labelAppointment(appt.type)} ${relativeDays(appt.starts_at)} has no outcome`,
      context: `${appt.title} · ${new Date(appt.starts_at).toLocaleString('en-GB')}`,
      value: appt.estimated_value ?? null,
      due_at: appt.starts_at,
      action: 'close_appointment', action_label: 'Did it happen?',
      link: appt.lead_id ? `/app/leads/${appt.lead_id}` : '/app/calendar',
      lead_id: appt.lead_id, appointment_id: appt.id,
    });
  }

  // --- 3. Hot leads going cold. The most expensive thing to get wrong.
  for (const lead of all<any>(
    `SELECT l.id, l.first_name, l.last_name, l.estimated_value, l.score, l.last_activity_at
     FROM leads l WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.status = 'open'
       AND l.temperature = 'hot' AND (l.last_activity_at IS NULL OR l.last_activity_at < ?) ${leadOwner}
     ORDER BY l.estimated_value DESC LIMIT ?`,
    [orgId, staleCutoff, ...ownerParam, LIMIT_PER_KIND],
  )) {
    const quietFor = lead.last_activity_at ? daysBetween(lead.last_activity_at) : null;
    items.push({
      id: `hot:${lead.id}`, kind: 'hot_lead', priority: 1,
      name: name(lead),
      reason: quietFor === null
        ? 'Hot lead — never contacted'
        : `Hot lead — no contact for ${plural(quietFor, 'day')}`,
      context: `Score ${lead.score}/100 · ${lead.estimated_value ? 'estimated ' : ''}${lead.estimated_value ? money(lead.estimated_value) : 'no value yet'}`,
      value: lead.estimated_value, due_at: null,
      temperature: 'hot', score: lead.score,
      action: 'contact', action_label: 'Contact now',
      template_key: 'first_contact',
      link: `/app/leads/${lead.id}`, lead_id: lead.id,
    });
  }

  // --- 4. A survey was done and nobody quoted it. Pure lost revenue.
  for (const survey of all<any>(
    `SELECT s.id, s.completed_at, s.recommended_system, s.feasible, s.lead_id,
            l.first_name, l.last_name, l.estimated_value
     FROM site_surveys s JOIN leads l ON l.id = s.lead_id
     WHERE s.org_id = ? AND s.status = 'completed' AND l.status = 'open' AND l.deleted_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM quotations q
         WHERE q.lead_id = s.lead_id AND q.org_id = s.org_id AND q.status != 'cancelled'
           AND q.created_at >= s.completed_at
       )
       ${leadOwner}
     ORDER BY s.completed_at DESC LIMIT ?`,
    [orgId, ...ownerParam, LIMIT_PER_KIND],
  )) {
    items.push({
      id: `survey:${survey.id}`, kind: 'survey_to_quote', priority: 1,
      name: name(survey),
      reason: `Site survey completed ${relativeDays(survey.completed_at)} — quotation not created`,
      context: [
        survey.recommended_system,
        survey.completed_at ? `surveyed ${relativeDays(survey.completed_at)}` : null,
        survey.feasible === 0 ? 'marked NOT feasible' : null,
      ].filter(Boolean).join(' · ') || null,
      value: survey.estimated_value, due_at: survey.completed_at,
      action: 'create_quote', action_label: 'Create quotation',
      link: `/app/surveys/${survey.id}`,
      lead_id: survey.lead_id, survey_id: survey.id,
    });
  }

  // --- 5. Quotations the customer opened but never answered.
  for (const quote of all<any>(
    `SELECT q.id, q.number, q.total, q.currency, q.sent_at, q.first_viewed_at, q.last_viewed_at,
            q.view_count, q.status, q.lead_id,
            l.first_name, l.last_name, l.temperature, l.score
     FROM quotations q LEFT JOIN leads l ON l.id = q.lead_id
     WHERE q.org_id = ? AND q.status IN ('sent','viewed','awaiting_response')
       ${mine ? 'AND q.owner_id = ?' : ''}
     ORDER BY (q.first_viewed_at IS NULL), q.sent_at LIMIT ?`,
    [orgId, ...ownerParam, LIMIT_PER_KIND],
  )) {
    const viewed = Boolean(quote.first_viewed_at);
    const waiting = quote.sent_at ? daysBetween(quote.sent_at) : 0;
    items.push({
      id: `quote:${quote.id}`, kind: viewed ? 'quote_viewed' : 'quote_awaiting',
      // Someone who opened the proposal and went quiet is the warmest call you
      // can make today; one that was never opened can wait a beat.
      priority: viewed ? 1 : 2,
      name: quote.lead_id ? `${quote.first_name ?? ''} ${quote.last_name ?? ''}`.trim() : quote.number,
      reason: viewed
        ? `Quotation ${money(quote.total, quote.currency)} opened ${relativeDays(quote.last_viewed_at ?? quote.first_viewed_at)} with no response`
        : `Quotation ${money(quote.total, quote.currency)} sent ${plural(waiting, 'day')} ago, no response`,
      context: [
        quote.number,
        quote.sent_at ? `sent ${relativeDays(quote.sent_at)}` : 'not sent yet',
        viewed ? `first opened ${relativeDays(quote.first_viewed_at)}` : 'not opened yet',
        viewed && quote.view_count > 0 ? `${quote.view_count} view${quote.view_count === 1 ? '' : 's'}` : null,
      ].filter(Boolean).join(' · '),
      value: quote.total, due_at: quote.sent_at,
      temperature: quote.temperature ?? null, score: quote.score ?? null,
      action: 'follow_up', action_label: 'Follow up',
      template_key: 'quote_follow_up',
      link: `/app/quotations/${quote.id}`,
      lead_id: quote.lead_id, quotation_id: quote.id,
    });
  }

  // --- 6. Appointments in the next two days, so nobody turns up unprepared.
  for (const appt of all<any>(
    `SELECT a.id, a.title, a.type, a.starts_at, a.location, a.lead_id, a.confirmation_sent_at,
            l.first_name, l.last_name, l.estimated_value
     FROM appointments a LEFT JOIN leads l ON l.id = a.lead_id
     WHERE a.org_id = ? AND a.status = 'scheduled' AND a.starts_at >= ? AND a.starts_at < ?
       ${mine ? 'AND (a.assignee_id = ? OR a.technician_id = ?)' : ''}
     ORDER BY a.starts_at LIMIT ?`,
    mine
      ? [orgId, now, addDays(startOfDay(), 2), userId, userId, LIMIT_PER_KIND]
      : [orgId, now, addDays(startOfDay(), 2), LIMIT_PER_KIND],
  )) {
    items.push({
      id: `appt:${appt.id}`, kind: 'appointment_upcoming', priority: 2,
      name: appt.lead_id ? name(appt) : appt.title,
      reason: `${labelAppointment(appt.type)} ${isToday(appt.starts_at) ? 'today' : 'tomorrow'} at ${formatTime(appt.starts_at)}`,
      context: [appt.title, appt.location, appt.confirmation_sent_at ? 'customer confirmed' : 'customer not told yet']
        .filter(Boolean).join(' · '),
      value: appt.estimated_value ?? null, due_at: appt.starts_at,
      action: 'view_appointment', action_label: 'View',
      link: appt.lead_id ? `/app/leads/${appt.lead_id}` : '/app/calendar',
      lead_id: appt.lead_id, appointment_id: appt.id,
    });
  }

  // --- 7. Open leads with nothing scheduled: the core promise of the product.
  for (const lead of all<any>(
    `SELECT l.id, l.first_name, l.last_name, l.estimated_value, l.created_at, l.temperature
     FROM leads l WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.status = 'open'
       AND l.next_action_id IS NULL ${leadOwner}
     ORDER BY l.estimated_value DESC LIMIT ?`,
    [orgId, ...ownerParam, LIMIT_PER_KIND],
  )) {
    items.push({
      id: `noaction:${lead.id}`, kind: 'no_next_action', priority: 2,
      name: name(lead),
      reason: 'No next action scheduled',
      context: `Created ${relativeDays(lead.created_at)} · nothing planned`,
      value: lead.estimated_value, due_at: null,
      action: 'schedule', action_label: 'Schedule next step',
      link: `/app/leads/${lead.id}`, lead_id: lead.id,
    });
  }

  // --- 8. Quiet leads of any temperature, not just the hot ones.
  for (const lead of all<any>(
    `SELECT l.id, l.first_name, l.last_name, l.estimated_value, l.last_activity_at, l.temperature, l.score
     FROM leads l WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.status = 'open'
       AND l.temperature != 'hot' AND l.last_activity_at IS NOT NULL AND l.last_activity_at < ?
       ${leadOwner}
     ORDER BY l.estimated_value DESC LIMIT ?`,
    [orgId, staleCutoff, ...ownerParam, LIMIT_PER_KIND],
  )) {
    items.push({
      id: `idle:${lead.id}`, kind: 'idle_lead', priority: 3,
      name: name(lead),
      reason: `${temperatureWord(lead.temperature, true)}— no activity for ${plural(daysBetween(lead.last_activity_at), 'day')}`,
      context: `Score ${lead.score}/100 · last contact ${relativeDays(lead.last_activity_at)}`,
      value: lead.estimated_value, due_at: null,
      temperature: lead.temperature, score: lead.score,
      action: 'contact', action_label: 'Contact customer',
      template_key: 'first_contact',
      link: `/app/leads/${lead.id}`, lead_id: lead.id,
    });
  }

  // --- 9. Unassigned leads. Only a manager can fix these.
  if (seesAll) {
    for (const lead of all<any>(
      `SELECT l.id, l.first_name, l.last_name, l.estimated_value, l.created_at FROM leads l
       WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.status = 'open' AND l.owner_id IS NULL
       ORDER BY l.created_at DESC LIMIT ?`,
      [orgId, LIMIT_PER_KIND],
    )) {
      items.push({
        id: `unassigned:${lead.id}`, kind: 'unassigned', priority: 1,
        name: name(lead), reason: 'Nobody owns this lead',
        context: `Arrived ${relativeDays(lead.created_at)}`,
        value: lead.estimated_value, due_at: null,
        action: 'assign', action_label: 'Assign',
        link: `/app/leads/${lead.id}`, lead_id: lead.id,
      });
    }
  }

  // --- 10. Sold work that is not in the diary. Money already won, and the
  // customer is waiting: a won lead with no installation booked at all, and a
  // job whose planned date has arrived.
  for (const won of all<any>(
    `SELECT l.id, l.first_name, l.last_name, l.estimated_value, l.won_at,
            p.id AS project_id, p.planned_install_date
     FROM leads l
     LEFT JOIN projects p ON p.lead_id = l.id AND p.status != 'cancelled'
     WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.status = 'won' ${leadOwner}
       AND NOT EXISTS (
         SELECT 1 FROM appointments a
         WHERE a.lead_id = l.id AND a.org_id = l.org_id
           AND a.type = 'installation' AND a.status IN ('scheduled', 'completed')
       )
       AND (p.id IS NULL OR p.planned_install_date IS NULL)
     ORDER BY l.estimated_value DESC LIMIT ?`,
    [orgId, ...ownerParam, LIMIT_PER_KIND],
  )) {
    items.push({
      id: `install:${won.id}`, kind: 'installation_unscheduled', priority: 2,
      name: name(won),
      reason: 'Won job — installation not scheduled',
      context: `Won ${relativeDays(won.won_at)} · ${money(won.estimated_value)} · nothing in the diary`,
      value: won.estimated_value, due_at: null,
      action: 'schedule_installation', action_label: 'Schedule installation',
      link: `/app/leads/${won.id}`,
      lead_id: won.id, project_id: won.project_id ?? null,
    });
  }

  // Jobs that are booked but whose date has arrived without being progressed.
  for (const project of all<any>(
    `SELECT p.id, p.name, p.installation_status, p.planned_install_date, p.contract_value, p.lead_id,
            c.first_name, c.last_name
     FROM projects p LEFT JOIN customers c ON c.id = p.customer_id
     WHERE p.org_id = ? AND p.status IN ('won','scheduled','in_progress','commissioned')
       AND p.planned_install_date IS NOT NULL AND p.planned_install_date <= ?
       AND p.installation_status != 'handed_over'
     ORDER BY p.planned_install_date LIMIT ?`,
    [orgId, addDays(new Date(), 3), LIMIT_PER_KIND],
  )) {
    items.push({
      id: `project:${project.id}`, kind: 'installation_due', priority: 3,
      name: `${project.first_name ?? ''} ${project.last_name ?? ''}`.trim() || project.name,
      reason: `Installation due ${relativeDays(project.planned_install_date)}`,
      context: [project.name, project.installation_status.replace(/_/g, ' ')].filter(Boolean).join(' · '),
      value: project.contract_value, due_at: project.planned_install_date,
      action: 'open', action_label: 'Open job',
      link: `/app/projects/${project.id}`,
      lead_id: project.lead_id, project_id: project.id,
    });
  }

  // --- 11. Lost leads the customer asked us to come back to.
  for (const lead of all<any>(
    `SELECT l.id, l.first_name, l.last_name, l.estimated_value, l.recovery_date, lr.name AS reason
     FROM leads l LEFT JOIN lost_reasons lr ON lr.id = l.lost_reason_id
     WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.status = 'lost'
       AND l.recovery_date IS NOT NULL AND l.recovery_date <= ? ${leadOwner}
     ORDER BY l.recovery_date LIMIT ?`,
    [orgId, addDays(new Date(), 7), ...ownerParam, LIMIT_PER_KIND],
  )) {
    items.push({
      id: `recovery:${lead.id}`, kind: 'recovery_due', priority: 3,
      name: name(lead), reason: 'Asked us to come back around now',
      context: `${lead.reason ?? 'Lost'} · recontact ${relativeDays(lead.recovery_date)}`,
      value: lead.estimated_value, due_at: lead.recovery_date,
      action: 'contact', action_label: 'Contact customer',
      link: `/app/leads/${lead.id}`, lead_id: lead.id,
    });
  }

  attachScheduledFollowUps(orgId, items);

  // Highest priority first, then by how warm and how valuable — the order an
  // owner would pick if they read the whole list themselves. Temperature and
  // score come straight from the existing scoring system; nothing new is
  // computed here.
  return items.sort((a, b) => a.priority - b.priority || rank(b) - rank(a));
}

const TEMPERATURE_WEIGHT: Record<string, number> = { hot: 2, warm: 1, cold: 0 };

/**
 * Orders items inside one priority band. Money dominates — a €40k job outranks a
 * €4k one — with the lead's own temperature and score breaking ties between
 * comparable amounts.
 */
function rank(item: AttentionItem): number {
  const value = item.value ?? 0;
  const temperature = (TEMPERATURE_WEIGHT[item.temperature ?? ''] ?? 0) * 1500;
  const score = (item.score ?? 0) * 10;
  return value + temperature + score;
}

/**
 * Tells the owner what an enabled sequence is about to do for this lead, so the
 * dashboard and the automation engine never disagree about who is chasing whom.
 */
function attachScheduledFollowUps(orgId: string, items: AttentionItem[]): void {
  const leadIds = [...new Set(items.map((i) => i.lead_id).filter(Boolean) as string[])];
  if (leadIds.length === 0) return;
  const placeholders = leadIds.map(() => '?').join(',');
  const scheduled = all<{ lead_id: string; next_run_at: string }>(
    `SELECT lead_id, MIN(next_run_at) AS next_run_at FROM automation_runs
     WHERE org_id = ? AND status = 'active' AND paused_at IS NULL AND next_run_at IS NOT NULL
       AND lead_id IN (${placeholders})
     GROUP BY lead_id`,
    [orgId, ...leadIds],
  );
  const byLead = new Map(scheduled.map((row) => [row.lead_id, row.next_run_at]));
  for (const item of items) {
    if (item.lead_id && byLead.has(item.lead_id)) item.next_automated_at = byLead.get(item.lead_id)!;
  }
}

/** Counts per kind, so the UI can group without re-querying. */
export function summariseAttention(items: AttentionItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) out[item.kind] = (out[item.kind] ?? 0) + 1;
  return out;
}

export function staleHoursFor(orgId: string): number {
  return get<{ stale_lead_hours: number }>(
    'SELECT stale_lead_hours FROM organizations WHERE id = ?', [orgId],
  )?.stale_lead_hours ?? 48;
}

/** Whole days between now and a timestamp, at least 1 so "0 days ago" never prints. */
function daysBetween(iso: string | null): number {
  if (!iso) return 0;
  return Math.max(1, Math.round(Math.abs(Date.now() - new Date(iso).getTime()) / 86_400_000));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "Hot lead — ", "Warm lead " — or nothing when the lead is not the subject. */
function temperatureWord(temperature: string | null | undefined, asNoun = false): string {
  if (!temperature) return asNoun ? 'Lead ' : '';
  const word = temperature.charAt(0).toUpperCase() + temperature.slice(1);
  return asNoun ? `${word} lead ` : `${word} lead — `;
}

function labelAppointment(type: string): string {
  return ({
    site_survey: 'Site survey', sales_meeting: 'Sales meeting', call: 'Call',
    installation: 'Installation', service: 'Service visit', other: 'Appointment',
  } as Record<string, string>)[type] ?? 'Appointment';
}

function relativeDays(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const days = Math.round(Math.abs(diff) / 86_400_000);
  const hours = Math.round(Math.abs(diff) / 3_600_000);
  const future = diff < 0;
  if (hours < 1) return future ? 'within the hour' : 'just now';
  if (hours < 24) return future ? `in ${hours} h` : `${hours} h ago`;
  if (days === 1) return future ? 'tomorrow' : 'yesterday';
  return future ? `in ${days} days` : `${days} days ago`;
}

function isToday(iso: string): boolean {
  return new Date(iso).toDateString() === new Date().toDateString();
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}
