import { all, get } from './db.ts';
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
    `SELECT t.id, t.title, t.due_at, t.priority, t.lead_id, t.type,
            l.first_name, l.last_name, l.estimated_value, l.phone, l.email
     FROM tasks t LEFT JOIN leads l ON l.id = t.lead_id
     WHERE t.org_id = ? AND t.status = 'open' AND t.due_at < ? ${mine ? 'AND t.assignee_id = ?' : ''}
     ORDER BY t.due_at LIMIT ?`,
    [orgId, now, ...ownerParam, LIMIT_PER_KIND],
  )) {
    items.push({
      id: `task:${task.id}`, kind: 'overdue_task', priority: 1,
      name: task.lead_id ? name(task) : task.title,
      reason: 'Follow-up overdue',
      context: `${task.title} · due ${relativeDays(task.due_at)}`,
      value: task.estimated_value ?? null,
      due_at: task.due_at,
      action: task.lead_id ? 'contact' : 'open',
      action_label: task.type === 'call' ? 'Call now' : 'Contact now',
      link: task.lead_id ? `/app/leads/${task.lead_id}` : '/app/tasks',
      lead_id: task.lead_id, task_id: task.id,
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
      reason: 'Appointment not closed off',
      context: `${appt.title} · was ${relativeDays(appt.starts_at)}`,
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
    items.push({
      id: `hot:${lead.id}`, kind: 'hot_lead', priority: 1,
      name: name(lead),
      reason: 'Hot lead going quiet',
      context: `Score ${lead.score} · last contact ${lead.last_activity_at ? relativeDays(lead.last_activity_at) : 'never'}`,
      value: lead.estimated_value, due_at: null,
      action: 'contact', action_label: 'Contact now',
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
      reason: 'Survey completed, no quotation yet',
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
    `SELECT q.id, q.number, q.total, q.currency, q.sent_at, q.first_viewed_at, q.view_count, q.status,
            q.lead_id, l.first_name, l.last_name
     FROM quotations q LEFT JOIN leads l ON l.id = q.lead_id
     WHERE q.org_id = ? AND q.status IN ('sent','viewed','awaiting_response')
       ${mine ? 'AND q.owner_id = ?' : ''}
     ORDER BY (q.first_viewed_at IS NULL), q.sent_at LIMIT ?`,
    [orgId, ...ownerParam, LIMIT_PER_KIND],
  )) {
    const viewed = Boolean(quote.first_viewed_at);
    items.push({
      id: `quote:${quote.id}`, kind: viewed ? 'quote_viewed' : 'quote_awaiting',
      // Someone who opened the proposal and went quiet is the warmest call you
      // can make today; one that was never opened can wait a beat.
      priority: viewed ? 1 : 2,
      name: quote.lead_id ? `${quote.first_name ?? ''} ${quote.last_name ?? ''}`.trim() : quote.number,
      reason: viewed ? 'Quotation opened but not answered' : 'Quotation sent, no response',
      context: [
        quote.number,
        quote.sent_at ? `sent ${relativeDays(quote.sent_at)}` : 'not sent yet',
        viewed && quote.view_count > 0 ? `opened ${quote.view_count}×` : null,
      ].filter(Boolean).join(' · '),
      value: quote.total, due_at: quote.sent_at,
      action: 'follow_up', action_label: 'Follow up',
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
      reason: isToday(appt.starts_at) ? 'Appointment today' : 'Appointment tomorrow',
      context: [appt.title, formatTime(appt.starts_at), appt.location].filter(Boolean).join(' · '),
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
    `SELECT l.id, l.first_name, l.last_name, l.estimated_value, l.last_activity_at, l.temperature
     FROM leads l WHERE l.org_id = ? AND l.deleted_at IS NULL AND l.status = 'open'
       AND l.temperature != 'hot' AND l.last_activity_at IS NOT NULL AND l.last_activity_at < ?
       ${leadOwner}
     ORDER BY l.estimated_value DESC LIMIT ?`,
    [orgId, staleCutoff, ...ownerParam, LIMIT_PER_KIND],
  )) {
    items.push({
      id: `idle:${lead.id}`, kind: 'idle_lead', priority: 3,
      name: name(lead),
      reason: 'No recent contact',
      context: `Last contact ${relativeDays(lead.last_activity_at)}`,
      value: lead.estimated_value, due_at: null,
      action: 'contact', action_label: 'Contact customer',
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

  // --- 10. Installations that need a date or a handover.
  for (const project of all<any>(
    `SELECT p.id, p.name, p.installation_status, p.planned_install_date, p.contract_value, p.lead_id,
            c.first_name, c.last_name
     FROM projects p LEFT JOIN customers c ON c.id = p.customer_id
     WHERE p.org_id = ? AND p.status IN ('won','scheduled','in_progress','commissioned')
       AND (p.planned_install_date IS NULL OR p.planned_install_date <= ?)
     ORDER BY (p.planned_install_date IS NULL) DESC, p.planned_install_date LIMIT ?`,
    [orgId, addDays(new Date(), 3), LIMIT_PER_KIND],
  )) {
    const unplanned = !project.planned_install_date;
    items.push({
      id: `project:${project.id}`, kind: 'installation_due', priority: unplanned ? 2 : 3,
      name: `${project.first_name ?? ''} ${project.last_name ?? ''}`.trim() || project.name,
      reason: unplanned ? 'Sold job with no installation date' : 'Installation due',
      context: [
        project.name,
        project.planned_install_date ? `planned ${relativeDays(project.planned_install_date)}` : 'no date set',
        project.installation_status.replace(/_/g, ' '),
      ].filter(Boolean).join(' · '),
      value: project.contract_value, due_at: project.planned_install_date,
      action: 'open', action_label: unplanned ? 'Plan it' : 'Open job',
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

  // Highest priority first, then by money at stake: the order an owner would
  // pick if they read the whole list themselves.
  return items.sort((a, b) => a.priority - b.priority || (b.value ?? 0) - (a.value ?? 0));
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
