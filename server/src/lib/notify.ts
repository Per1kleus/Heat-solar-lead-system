import { all, get, insert, parseJson } from './db.ts';
import { newId } from './ids.ts';
import { nowIso } from './time.ts';

export type NotificationType =
  | 'lead_assigned' | 'hot_lead' | 'task_overdue' | 'task_due' | 'quote_stale'
  | 'quote_accepted' | 'appointment_soon' | 'lead_idle' | 'deal_won' | 'deal_lost'
  | 'no_next_action' | 'automation' | 'survey_assigned' | 'limit';

export interface NotifyInput {
  orgId: string;
  userId: string;
  type: NotificationType;
  severity?: 'info' | 'warning' | 'critical' | 'success';
  title: string;
  body?: string;
  link?: string;
  leadId?: string | null;
  /** Prevents the same alert being raised twice (unique per org+user). */
  dedupeKey?: string;
}

const DEFAULT_PREFS: Record<NotificationType, boolean> = {
  lead_assigned: true, hot_lead: true, task_overdue: true, task_due: true,
  quote_stale: true, quote_accepted: true, appointment_soon: true, lead_idle: true,
  deal_won: true, deal_lost: false, no_next_action: true, automation: false,
  survey_assigned: true, limit: true,
};

export function notify(input: NotifyInput): string | null {
  const user = get<{ notif_prefs: string }>('SELECT notif_prefs FROM users WHERE id = ? AND org_id = ?', [
    input.userId, input.orgId,
  ]);
  if (!user) return null;
  const prefs = { ...DEFAULT_PREFS, ...parseJson<Record<string, boolean>>(user.notif_prefs, {}) };
  if (prefs[input.type] === false) return null;

  if (input.dedupeKey) {
    const existing = get<{ id: string }>(
      'SELECT id FROM notifications WHERE org_id = ? AND user_id = ? AND dedupe_key = ?',
      [input.orgId, input.userId, input.dedupeKey],
    );
    if (existing) return existing.id;
  }

  const id = newId('ntf');
  insert('notifications', {
    id,
    org_id: input.orgId,
    user_id: input.userId,
    type: input.type,
    severity: input.severity ?? 'info',
    title: input.title,
    body: input.body ?? null,
    link: input.link ?? null,
    lead_id: input.leadId ?? null,
    dedupe_key: input.dedupeKey ?? null,
    created_at: nowIso(),
  });
  return id;
}

/** Notify every manager/owner in the org (used for escalations). */
export function notifyManagers(orgId: string, input: Omit<NotifyInput, 'orgId' | 'userId'>): void {
  const managers = all<{ id: string }>(
    "SELECT id FROM users WHERE org_id = ? AND status = 'active' AND role IN ('owner','admin','sales_manager')",
    [orgId],
  );
  for (const manager of managers) notify({ ...input, orgId, userId: manager.id });
}

export { DEFAULT_PREFS as defaultNotificationPrefs };
