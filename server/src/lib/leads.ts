import { all, get, insert, parseJson, run } from './db.ts';
import { newId } from './ids.ts';
import { addMinutes, nowIso } from './time.ts';
import { computeScore, gatherSignals, loadRules, countCompleteness, type ScoreResult } from './scoring.ts';
import { emit } from './events.ts';
import { audit } from './audit.ts';
import { notify } from './notify.ts';
import { badRequest, conflict, notFound } from './errors.ts';

/** Lead joined with the labels the UI always needs. */
export const LEAD_SELECT = `
  SELECT l.*,
         s.key  AS source_key,  s.name AS source_name,
         st.key AS stage_key,   st.name AS stage_name, st.color AS stage_color,
         st.probability AS stage_probability, st.type AS stage_type, st.position AS stage_position,
         u.first_name AS owner_first_name, u.last_name AS owner_last_name, u.avatar_color AS owner_color,
         lr.name AS lost_reason_name,
         t.id AS next_task_id, t.title AS next_task_title, t.due_at AS next_task_due_at,
         t.type AS next_task_type, t.priority AS next_task_priority
  FROM leads l
  LEFT JOIN lead_sources s   ON s.id = l.source_id
  LEFT JOIN pipeline_stages st ON st.id = l.stage_id
  LEFT JOIN users u          ON u.id = l.owner_id
  LEFT JOIN lost_reasons lr  ON lr.id = l.lost_reason_id
  LEFT JOIN tasks t          ON t.id = l.next_action_id AND t.status = 'open'
`;

export function loadLead(orgId: string, leadId: string): any {
  const lead = get<any>(`${LEAD_SELECT} WHERE l.id = ? AND l.org_id = ? AND l.deleted_at IS NULL`, [leadId, orgId]);
  if (!lead) throw notFound('That lead no longer exists.');
  return lead;
}

export function shapeLead(lead: any): any {
  if (!lead) return lead;
  return {
    ...lead,
    project_types: parseJson<string[]>(lead.project_types, []),
    score_breakdown: parseJson<unknown[]>(lead.score_breakdown, []),
    custom_data: parseJson<Record<string, unknown>>(lead.custom_data, {}),
    utm: parseJson<Record<string, unknown>>(lead.utm, {}),
    full_name: `${lead.first_name} ${lead.last_name}`.trim(),
    owner_name: lead.owner_first_name ? `${lead.owner_first_name} ${lead.owner_last_name}` : null,
    pv_interest: !!lead.pv_interest,
    hp_interest: !!lead.hp_interest,
    battery_interest: !!lead.battery_interest,
    ev_charger_interest: !!lead.ev_charger_interest,
    backup_power_interest: !!lead.backup_power_interest,
    hp_dhw_required: !!lead.hp_dhw_required,
    hp_cooling_required: !!lead.hp_cooling_required,
    hp_removal_required: !!lead.hp_removal_required,
    pv_existing_system: !!lead.pv_existing_system,
    budget_known: !!lead.budget_known,
    automation_paused: !!lead.automation_paused,
    consent_marketing: !!lead.consent_marketing,
    has_next_action: Boolean(lead.next_task_id),
    tags: listLeadTags(lead.org_id, lead.id),
  };
}

export function listLeadTags(orgId: string, leadId: string) {
  return all(
    `SELECT t.id, t.name, t.color FROM lead_tags lt
     JOIN tags t ON t.id = lt.tag_id
     WHERE lt.org_id = ? AND lt.lead_id = ? ORDER BY t.name`,
    [orgId, leadId],
  );
}

// --- duplicate detection -------------------------------------------------

export function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, '').replace(/^00/, '+');
  const bare = digits.replace(/^\+?30/, '').replace(/\D/g, '');
  return bare.length >= 7 ? bare.slice(-10) : null;
}

export function dedupeKeyFor(phone?: string | null, email?: string | null): string | null {
  const p = normalizePhone(phone);
  if (p) return `p:${p}`;
  const e = email?.trim().toLowerCase();
  return e ? `e:${e}` : null;
}

export interface DuplicateMatch {
  id: string;
  reference: string;
  full_name: string;
  status: string;
  stage_name: string | null;
  owner_name: string | null;
  created_at: string;
  matched_on: 'phone' | 'email';
  type: 'lead' | 'customer';
}

export function findDuplicates(
  orgId: string, phone?: string | null, email?: string | null, excludeLeadId?: string,
): DuplicateMatch[] {
  const matches: DuplicateMatch[] = [];
  const normalized = normalizePhone(phone);
  const mail = email?.trim().toLowerCase() || null;
  if (!normalized && !mail) return matches;

  const leads = all<any>(
    `SELECT l.id, l.reference, l.first_name, l.last_name, l.phone, l.email, l.status, l.created_at,
            st.name AS stage_name, u.first_name AS owner_first_name, u.last_name AS owner_last_name
     FROM leads l
     LEFT JOIN pipeline_stages st ON st.id = l.stage_id
     LEFT JOIN users u ON u.id = l.owner_id
     WHERE l.org_id = ? AND l.deleted_at IS NULL AND (l.dedupe_key = ? OR lower(l.email) = ?)
     ORDER BY l.created_at DESC LIMIT 5`,
    [orgId, normalized ? `p:${normalized}` : ' ', mail ?? ' '],
  );
  for (const l of leads) {
    if (excludeLeadId && l.id === excludeLeadId) continue;
    matches.push({
      id: l.id, reference: l.reference, full_name: `${l.first_name} ${l.last_name}`,
      status: l.status, stage_name: l.stage_name,
      owner_name: l.owner_first_name ? `${l.owner_first_name} ${l.owner_last_name}` : null,
      created_at: l.created_at,
      matched_on: normalized && normalizePhone(l.phone) === normalized ? 'phone' : 'email',
      type: 'lead',
    });
  }

  const customers = all<any>(
    `SELECT id, first_name, last_name, phone, email, created_at FROM customers
     WHERE org_id = ? AND (lower(email) = ? OR phone IS NOT NULL) ORDER BY created_at DESC LIMIT 50`,
    [orgId, mail ?? ' '],
  );
  for (const c of customers) {
    const phoneHit = normalized && normalizePhone(c.phone) === normalized;
    const emailHit = mail && c.email?.toLowerCase() === mail;
    if (!phoneHit && !emailHit) continue;
    matches.push({
      id: c.id, reference: 'CUSTOMER', full_name: `${c.first_name} ${c.last_name}`,
      status: 'customer', stage_name: null, owner_name: null, created_at: c.created_at,
      matched_on: phoneHit ? 'phone' : 'email', type: 'customer',
    });
  }
  return matches;
}

// --- assignment ----------------------------------------------------------

export function pickAssignee(
  orgId: string, lead: Record<string, any>,
): { userId: string | null; ruleName: string | null } {
  const rules = all<any>(
    'SELECT * FROM assignment_rules WHERE org_id = ? AND is_active = 1 ORDER BY position, created_at',
    [orgId],
  );
  for (const rule of rules) {
    const conditions = parseJson<{ field: string; op: string; value: any }[]>(rule.conditions, []);
    if (!conditions.every((c) => matchCondition(lead, c))) continue;
    const userId = resolveStrategy(orgId, rule);
    if (userId !== undefined) return { userId, ruleName: rule.name };
  }
  // No rule matched: fall back to round-robin across active sales users.
  return { userId: roundRobin(orgId, null), ruleName: null };
}

function resolveStrategy(orgId: string, rule: any): string | null | undefined {
  switch (rule.strategy) {
    case 'specific_user': {
      const user = get<{ id: string }>(
        "SELECT id FROM users WHERE id = ? AND org_id = ? AND status = 'active'", [rule.target_user_id, orgId],
      );
      return user?.id ?? undefined;
    }
    case 'unassigned':
      return null;
    case 'least_open': {
      const row = get<{ id: string }>(
        `SELECT u.id FROM users u
         LEFT JOIN leads l ON l.owner_id = u.id AND l.status = 'open' AND l.deleted_at IS NULL
         WHERE u.org_id = ? AND u.status = 'active' AND u.role IN ('salesperson','sales_manager','owner','admin')
         GROUP BY u.id ORDER BY COUNT(l.id) ASC, u.created_at ASC LIMIT 1`,
        [orgId],
      );
      return row?.id ?? undefined;
    }
    default:
      return roundRobin(orgId, rule) ?? undefined;
  }
}

function roundRobin(orgId: string, rule: any | null): string | null {
  const candidates = all<{ id: string }>(
    `SELECT id FROM users WHERE org_id = ? AND status = 'active'
       AND role IN ('salesperson','sales_manager','owner','admin')
     ORDER BY created_at`,
    [orgId],
  );
  if (candidates.length === 0) return null;
  const lastId = rule?.last_user_id ?? get<{ value: string }>(
    'SELECT value FROM schema_meta WHERE key = ?', [`rr:${orgId}`],
  )?.value;
  const lastIndex = candidates.findIndex((c) => c.id === lastId);
  const next = candidates[(lastIndex + 1) % candidates.length];
  if (rule) run('UPDATE assignment_rules SET last_user_id = ? WHERE id = ?', [next.id, rule.id]);
  else {
    run(
      'INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      [`rr:${orgId}`, next.id],
    );
  }
  return next.id;
}

export function matchCondition(lead: Record<string, any>, c: { field: string; op: string; value: any }): boolean {
  const actual = lead[c.field];
  switch (c.op) {
    case 'eq': return String(actual ?? '') === String(c.value);
    case 'neq': return String(actual ?? '') !== String(c.value);
    case 'gt': return Number(actual ?? 0) > Number(c.value);
    case 'gte': return Number(actual ?? 0) >= Number(c.value);
    case 'lt': return Number(actual ?? 0) < Number(c.value);
    case 'lte': return Number(actual ?? 0) <= Number(c.value);
    case 'contains':
      if (Array.isArray(actual)) return actual.includes(c.value);
      return String(actual ?? '').toLowerCase().includes(String(c.value).toLowerCase());
    case 'in': return Array.isArray(c.value) && c.value.map(String).includes(String(actual));
    case 'is_empty': return actual === null || actual === undefined || actual === '';
    case 'is_set': return !(actual === null || actual === undefined || actual === '');
    default: return false;
  }
}

// --- scoring and next action --------------------------------------------

export function rescoreLead(orgId: string, leadId: string, options: { silent?: boolean } = {}): ScoreResult {
  const lead = get<any>(
    `SELECT l.*, s.key AS source_key, s.name AS source_name FROM leads l
     LEFT JOIN lead_sources s ON s.id = l.source_id WHERE l.id = ? AND l.org_id = ?`,
    [leadId, orgId],
  );
  if (!lead) throw notFound('That lead no longer exists.');
  const signals = gatherSignals(orgId, leadId, lead.last_activity_at);
  const result = computeScore(lead, loadRules(orgId), signals);
  const previousTemp = lead.temperature;
  run(
    `UPDATE leads SET score = ?, temperature = ?, score_breakdown = ?, scored_at = ?, updated_at = ?
     WHERE id = ? AND org_id = ?`,
    [result.score, result.temperature, JSON.stringify(result.breakdown), nowIso(), nowIso(), leadId, orgId],
  );
  if (!options.silent && previousTemp !== result.temperature) {
    logActivity({
      orgId, leadId, type: 'score',
      title: `Lead temperature changed: ${previousTemp} to ${result.temperature}`,
      body: `Score is now ${result.score}/100.`,
      meta: { from: previousTemp, to: result.temperature, score: result.score },
    });
    emit({ type: 'temperature_changed', orgId, leadId, from: previousTemp, to: result.temperature });
  }
  return result;
}

/** A lead's next action is always its earliest open task. */
export function recomputeNextAction(orgId: string, leadId: string): string | null {
  const task = get<{ id: string }>(
    `SELECT id FROM tasks WHERE org_id = ? AND lead_id = ? AND status = 'open' AND is_next_action = 1
     ORDER BY (due_at IS NULL), due_at ASC LIMIT 1`,
    [orgId, leadId],
  );
  run('UPDATE leads SET next_action_id = ? WHERE id = ? AND org_id = ?', [task?.id ?? null, leadId, orgId]);
  return task?.id ?? null;
}

// --- activity timeline ---------------------------------------------------

export interface ActivityInput {
  orgId: string;
  leadId?: string | null;
  customerId?: string | null;
  projectId?: string | null;
  quotationId?: string | null;
  type: string;
  direction?: 'inbound' | 'outbound' | 'internal';
  title: string;
  body?: string | null;
  meta?: Record<string, unknown>;
  outcome?: string | null;
  durationSec?: number | null;
  userId?: string | null;
  occurredAt?: string;
  /** Marks real contact with the customer: drives last-activity and sequence stops. */
  isCustomerTouch?: boolean;
}

export function logActivity(input: ActivityInput): string {
  const id = newId('act');
  const occurredAt = input.occurredAt ?? nowIso();
  insert('activities', {
    id,
    org_id: input.orgId,
    lead_id: input.leadId ?? null,
    customer_id: input.customerId ?? null,
    project_id: input.projectId ?? null,
    quotation_id: input.quotationId ?? null,
    type: input.type,
    direction: input.direction ?? 'internal',
    title: input.title,
    body: input.body ?? null,
    meta: JSON.stringify(input.meta ?? {}),
    outcome: input.outcome ?? null,
    duration_sec: input.durationSec ?? null,
    occurred_at: occurredAt,
    user_id: input.userId ?? null,
    is_customer_touch: input.isCustomerTouch ? 1 : 0,
    created_at: nowIso(),
  });
  if (input.leadId) {
    run('UPDATE leads SET last_activity_at = ?, updated_at = ? WHERE id = ? AND org_id = ?', [
      occurredAt, nowIso(), input.leadId, input.orgId,
    ]);
    if (input.isCustomerTouch) {
      const lead = get<{ first_contacted_at: string | null }>(
        'SELECT first_contacted_at FROM leads WHERE id = ? AND org_id = ?', [input.leadId, input.orgId],
      );
      if (lead && !lead.first_contacted_at && input.direction === 'outbound') {
        run('UPDATE leads SET first_contacted_at = ? WHERE id = ? AND org_id = ?', [
          occurredAt, input.leadId, input.orgId,
        ]);
      }
      emit(
        input.direction === 'inbound'
          ? { type: 'customer_replied', orgId: input.orgId, leadId: input.leadId }
          : { type: 'lead_contacted', orgId: input.orgId, leadId: input.leadId },
      );
    }
  }
  return id;
}

// --- creation ------------------------------------------------------------

export interface CreateLeadOptions {
  orgId: string;
  userId?: string | null;
  channel?: 'manual' | 'web_form' | 'api' | 'webhook' | 'import';
  sourceKey?: string | null;
  /** When false, a matching phone/email raises a 409 the caller can surface. */
  allowDuplicate?: boolean;
  skipAutomation?: boolean;
  assignTo?: string | null;
  ip?: string | null;
}

const LEAD_COLUMNS = new Set([
  'first_name', 'last_name', 'company', 'phone', 'email', 'address', 'city', 'postal_code', 'region',
  'preferred_contact', 'notes', 'campaign', 'estimated_value', 'probability', 'expected_close_date',
  'urgency', 'budget_known', 'budget_amount', 'consent_marketing', 'gdpr_basis',
  'pv_interest', 'pv_existing_system', 'pv_desired_kwp', 'pv_annual_kwh', 'pv_monthly_bill', 'pv_roof_type',
  'pv_roof_orientation', 'pv_roof_area_m2', 'pv_roof_tilt', 'pv_shading', 'pv_property_type', 'pv_phase',
  'pv_grid_connection', 'pv_meter_number', 'pv_install_location', 'battery_interest', 'battery_kwh',
  'ev_charger_interest', 'ev_charger_kw', 'backup_power_interest',
  'hp_interest', 'hp_existing_system', 'hp_current_fuel', 'hp_annual_heating_cost', 'hp_property_type',
  'hp_property_m2', 'hp_floors', 'hp_emitters', 'hp_existing_boiler', 'hp_dhw_required', 'hp_dhw_litres',
  'hp_cooling_required', 'hp_insulation', 'hp_estimated_kw', 'hp_removal_required',
]);

export function pickLeadColumns(input: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!LEAD_COLUMNS.has(key) || value === undefined) continue;
    out[key] = value;
  }
  return out;
}

export function nextReference(orgId: string): string {
  const row = get<{ n: number }>('SELECT COUNT(*) AS n FROM leads WHERE org_id = ?', [orgId]);
  const year = new Date().getFullYear();
  let n = (row?.n ?? 0) + 1;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const ref = `L-${year}-${String(n).padStart(4, '0')}`;
    if (!get('SELECT 1 FROM leads WHERE org_id = ? AND reference = ?', [orgId, ref])) return ref;
    n += 1;
  }
  return `L-${year}-${Date.now().toString(36)}`;
}

export function createLead(
  input: Record<string, any>, options: CreateLeadOptions,
): { lead: any; duplicates: DuplicateMatch[] } {
  const { orgId } = options;
  if (!input.first_name?.trim() && !input.last_name?.trim()) {
    throw badRequest('A lead needs at least a first or last name.');
  }
  if (!input.phone && !input.email) {
    throw badRequest('A lead needs a phone number or an email address so it can be followed up.');
  }

  const duplicates = findDuplicates(orgId, input.phone, input.email);
  if (duplicates.length > 0 && options.allowDuplicate !== true) {
    throw conflict(
      `A ${duplicates[0].type} with this ${duplicates[0].matched_on} already exists (${duplicates[0].full_name}).`,
      { duplicates },
    );
  }

  const source = options.sourceKey
    ? get<{ id: string; key: string }>(
        'SELECT id, key FROM lead_sources WHERE org_id = ? AND key = ?', [orgId, options.sourceKey],
      )
    : null;
  const firstStage = get<{ id: string; probability: number }>(
    `SELECT id, probability FROM pipeline_stages WHERE org_id = ? AND is_active = 1 AND type = 'open'
     ORDER BY position LIMIT 1`,
    [orgId],
  );

  const columns = pickLeadColumns(input);
  const projectTypes: string[] = Array.isArray(input.project_types) ? input.project_types : [];
  // Keep the interest flags consistent with the chosen project types.
  if (projectTypes.includes('pv')) columns.pv_interest = 1;
  if (projectTypes.includes('heat_pump')) columns.hp_interest = 1;
  if (projectTypes.includes('battery')) columns.battery_interest = 1;
  if (projectTypes.includes('ev_charger')) columns.ev_charger_interest = 1;

  const id = newId('led');
  const now = nowIso();
  const assignee = options.assignTo !== undefined
    ? { userId: options.assignTo, ruleName: 'Manually assigned' }
    : pickAssignee(orgId, { ...input, source_key: source?.key ?? null, project_types: projectTypes });

  insert('leads', {
    id,
    org_id: orgId,
    reference: nextReference(orgId),
    ...columns,
    project_types: JSON.stringify(projectTypes),
    source_id: source?.id ?? null,
    owner_id: assignee.userId,
    stage_id: firstStage?.id ?? null,
    stage_entered_at: now,
    probability: input.probability ?? firstStage?.probability ?? 0,
    status: 'open',
    intake_channel: options.channel ?? 'manual',
    intake_payload: input.intake_payload ? JSON.stringify(input.intake_payload) : null,
    utm: JSON.stringify(input.utm ?? {}),
    custom_data: JSON.stringify(input.custom_data ?? {}),
    dedupe_key: dedupeKeyFor(input.phone, input.email),
    last_activity_at: now,
    created_by: options.userId ?? null,
    created_at: now,
    updated_at: now,
  });

  logActivity({
    orgId, leadId: id, type: 'created',
    title: `Lead created via ${labelChannel(options.channel ?? 'manual')}`,
    body: source ? `Source: ${source.key}` : null,
    meta: { channel: options.channel ?? 'manual', source: source?.key ?? null },
    userId: options.userId ?? null,
  });
  if (assignee.userId) {
    logActivity({
      orgId, leadId: id, type: 'assignment',
      title: `Assigned to ${userName(orgId, assignee.userId)}`,
      body: assignee.ruleName ? `Assignment rule: ${assignee.ruleName}` : 'Round-robin assignment',
      userId: options.userId ?? null,
    });
  }

  rescoreLead(orgId, id, { silent: true });
  audit({
    orgId, userId: options.userId ?? null, action: 'lead.created', entityType: 'lead', entityId: id,
    entityLabel: `${input.first_name} ${input.last_name}`,
    changes: { channel: options.channel, source: source?.key ?? null, owner_id: assignee.userId },
    ip: options.ip ?? null,
  });
  bumpUsage(orgId, 'leads_created');

  if (!options.skipAutomation) {
    emit({ type: 'lead_created', orgId, leadId: id, userId: options.userId ?? null });
    if (assignee.userId) emit({ type: 'lead_assigned', orgId, leadId: id, ownerId: assignee.userId });
  }

  return { lead: shapeLead(loadLead(orgId, id)), duplicates };
}

function labelChannel(channel: string): string {
  const labels: Record<string, string> = {
    manual: 'manual entry', web_form: 'the website form', api: 'the API',
    webhook: 'a webhook', import: 'a CSV import',
  };
  return labels[channel] ?? channel;
}

export function userName(orgId: string, userId: string | null): string {
  if (!userId) return 'nobody';
  const u = get<{ first_name: string; last_name: string }>(
    'SELECT first_name, last_name FROM users WHERE id = ? AND org_id = ?', [userId, orgId],
  );
  return u ? `${u.first_name} ${u.last_name}` : 'a removed user';
}

export function bumpUsage(orgId: string, metric: string): void {
  const period = new Date().toISOString().slice(0, 7);
  run(
    `INSERT INTO usage_counters (org_id, period, metric, value) VALUES (?, ?, ?, 1)
     ON CONFLICT(org_id, period, metric) DO UPDATE SET value = value + 1`,
    [orgId, period, metric],
  );
}

// --- stage and status transitions ---------------------------------------

export function moveStage(orgId: string, leadId: string, stageId: string, userId: string | null): any {
  const lead = loadLead(orgId, leadId);
  const stage = get<any>('SELECT * FROM pipeline_stages WHERE id = ? AND org_id = ?', [stageId, orgId]);
  if (!stage) throw notFound('That pipeline stage no longer exists.');
  if (stage.id === lead.stage_id) return shapeLead(lead);
  if (stage.type === 'lost') throw badRequest('Use "Mark as lost" so a reason is recorded.');

  const now = nowIso();
  run(
    'UPDATE leads SET stage_id = ?, stage_entered_at = ?, probability = ?, updated_at = ? WHERE id = ? AND org_id = ?',
    [stage.id, now, stage.probability, now, leadId, orgId],
  );
  logActivity({
    orgId, leadId, type: 'stage_change',
    title: `Moved to ${stage.name}`,
    body: lead.stage_name ? `Previous stage: ${lead.stage_name}` : null,
    meta: { from: lead.stage_key, to: stage.key },
    userId,
  });
  audit({
    orgId, userId, action: 'lead.stage_changed', entityType: 'lead', entityId: leadId,
    entityLabel: `${lead.first_name} ${lead.last_name}`,
    changes: { stage: { from: lead.stage_name, to: stage.name } },
  });
  emit({ type: 'stage_changed', orgId, leadId, fromStage: lead.stage_key ?? null, toStage: stage.key, userId });

  if (stage.type === 'won') return markWon(orgId, leadId, userId);
  rescoreLead(orgId, leadId);
  return shapeLead(loadLead(orgId, leadId));
}

export function markWon(orgId: string, leadId: string, userId: string | null, contractValue?: number): any {
  const lead = loadLead(orgId, leadId);
  const now = nowIso();
  const wonStage = get<{ id: string }>(
    "SELECT id FROM pipeline_stages WHERE org_id = ? AND type = 'won' ORDER BY position LIMIT 1", [orgId],
  );
  const value = contractValue ?? acceptedQuoteTotal(orgId, leadId) ?? lead.estimated_value;
  run(
    `UPDATE leads SET status = 'won', won_at = ?, lost_at = NULL, lost_reason_id = NULL, probability = 100,
       estimated_value = ?, stage_id = COALESCE(?, stage_id), stage_entered_at = ?, updated_at = ?
     WHERE id = ? AND org_id = ?`,
    [now, value, wonStage?.id ?? null, now, now, leadId, orgId],
  );
  logActivity({
    orgId, leadId, type: 'status_change', title: `Deal won for ${money(value)}`,
    body: 'Revenue recorded and the installation handover has started.', userId, meta: { value },
  });
  audit({
    orgId, userId, action: 'lead.won', entityType: 'lead', entityId: leadId,
    entityLabel: `${lead.first_name} ${lead.last_name}`, changes: { value },
  });
  emit({ type: 'lead_won', orgId, leadId, userId });
  return shapeLead(loadLead(orgId, leadId));
}

export function markLost(
  orgId: string, leadId: string, userId: string | null,
  payload: { lost_reason_id: string; lost_notes?: string | null; recovery_date?: string | null },
): any {
  const lead = loadLead(orgId, leadId);
  const reason = get<any>('SELECT * FROM lost_reasons WHERE id = ? AND org_id = ?', [payload.lost_reason_id, orgId]);
  if (!reason) throw badRequest('Choose a reason so the loss can be analysed later.');
  const now = nowIso();
  const lostStage = get<{ id: string }>(
    "SELECT id FROM pipeline_stages WHERE org_id = ? AND type = 'lost' ORDER BY position LIMIT 1", [orgId],
  );
  run(
    `UPDATE leads SET status = 'lost', lost_at = ?, won_at = NULL, lost_reason_id = ?, lost_notes = ?,
       recovery_date = ?, probability = 0, stage_id = COALESCE(?, stage_id), stage_entered_at = ?, updated_at = ?
     WHERE id = ? AND org_id = ?`,
    [now, reason.id, payload.lost_notes ?? null, payload.recovery_date ?? null, lostStage?.id ?? null, now, now, leadId, orgId],
  );
  // Open follow-ups on a lost lead are noise.
  run("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE org_id = ? AND lead_id = ? AND status = 'open'", [
    now, orgId, leadId,
  ]);
  recomputeNextAction(orgId, leadId);
  logActivity({
    orgId, leadId, type: 'status_change',
    title: `Marked as lost: ${reason.name}`,
    body: payload.recovery_date
      ? `Recovery scheduled for ${new Date(payload.recovery_date).toLocaleDateString('en-GB')}.`
      : payload.lost_notes ?? null,
    meta: { reason: reason.key, recovery_date: payload.recovery_date ?? null },
    userId,
  });
  audit({
    orgId, userId, action: 'lead.lost', entityType: 'lead', entityId: leadId,
    entityLabel: `${lead.first_name} ${lead.last_name}`,
    changes: { reason: reason.name, recovery_date: payload.recovery_date },
  });
  emit({ type: 'lead_lost', orgId, leadId, userId });
  return shapeLead(loadLead(orgId, leadId));
}

export function reopenLead(orgId: string, leadId: string, userId: string | null): any {
  const lead = loadLead(orgId, leadId);
  const stage = get<{ id: string; probability: number }>(
    `SELECT id, probability FROM pipeline_stages WHERE org_id = ? AND is_active = 1 AND type = 'open'
     ORDER BY position LIMIT 1`,
    [orgId],
  );
  const now = nowIso();
  run(
    `UPDATE leads SET status = 'open', won_at = NULL, lost_at = NULL, recovered_at = ?, stage_id = ?,
       stage_entered_at = ?, probability = ?, updated_at = ? WHERE id = ? AND org_id = ?`,
    [now, stage?.id ?? null, now, stage?.probability ?? 0, now, leadId, orgId],
  );
  logActivity({ orgId, leadId, type: 'status_change', title: 'Lead reopened', userId });
  audit({
    orgId, userId, action: 'lead.reopened', entityType: 'lead', entityId: leadId,
    entityLabel: `${lead.first_name} ${lead.last_name}`,
  });
  rescoreLead(orgId, leadId);
  return shapeLead(loadLead(orgId, leadId));
}

export function assignLead(orgId: string, leadId: string, ownerId: string | null, userId: string | null): any {
  const lead = loadLead(orgId, leadId);
  if (ownerId) {
    const owner = get<{ id: string }>(
      "SELECT id FROM users WHERE id = ? AND org_id = ? AND status = 'active'", [ownerId, orgId],
    );
    if (!owner) throw badRequest('That user is not active in this organisation.');
  }
  run('UPDATE leads SET owner_id = ?, updated_at = ? WHERE id = ? AND org_id = ?', [ownerId, nowIso(), leadId, orgId]);
  // Open tasks follow the lead to its new owner.
  run("UPDATE tasks SET assignee_id = ?, updated_at = ? WHERE org_id = ? AND lead_id = ? AND status = 'open'", [
    ownerId, nowIso(), orgId, leadId,
  ]);
  logActivity({
    orgId, leadId, type: 'assignment',
    title: ownerId ? `Reassigned to ${userName(orgId, ownerId)}` : 'Unassigned',
    body: `Previously ${lead.owner_first_name ? `${lead.owner_first_name} ${lead.owner_last_name}` : 'unassigned'}.`,
    userId,
  });
  audit({
    orgId, userId, action: 'lead.assigned', entityType: 'lead', entityId: leadId,
    entityLabel: `${lead.first_name} ${lead.last_name}`,
    changes: { owner: { from: lead.owner_id, to: ownerId } },
  });
  if (ownerId && ownerId !== userId) {
    notify({
      orgId, userId: ownerId, type: 'lead_assigned',
      severity: lead.temperature === 'hot' ? 'critical' : 'info',
      title: `${lead.temperature === 'hot' ? 'Hot lead' : 'Lead'} assigned to you: ${lead.first_name} ${lead.last_name}`,
      body: `${money(lead.estimated_value)} - ${lead.stage_name ?? 'New'}`,
      link: `/leads/${leadId}`, leadId,
    });
  }
  if (ownerId) emit({ type: 'lead_assigned', orgId, leadId, ownerId, byUserId: userId });
  return shapeLead(loadLead(orgId, leadId));
}

function acceptedQuoteTotal(orgId: string, leadId: string): number | null {
  const row = get<{ total: number }>(
    `SELECT total FROM quotations WHERE org_id = ? AND lead_id = ? AND status = 'accepted'
     ORDER BY accepted_at DESC LIMIT 1`,
    [orgId, leadId],
  );
  return row?.total ?? null;
}

export function money(value: unknown, currency = 'EUR'): string {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n);
}

export { countCompleteness };

/** Creates (or finds) the customer record behind a lead. Called when a deal is won. */
export function ensureCustomerForLead(orgId: string, leadId: string, userId: string | null): string {
  const lead = loadLead(orgId, leadId);
  if (lead.customer_id) return lead.customer_id;
  const existing = get<{ id: string }>(
    `SELECT id FROM customers WHERE org_id = ?
       AND ((phone IS NOT NULL AND phone = ?) OR (email IS NOT NULL AND lower(email) = ?)) LIMIT 1`,
    [orgId, lead.phone ?? ' ', lead.email?.toLowerCase() ?? ' '],
  );
  if (existing) {
    run('UPDATE leads SET customer_id = ? WHERE id = ? AND org_id = ?', [existing.id, leadId, orgId]);
    return existing.id;
  }
  const id = newId('cus');
  const now = nowIso();
  insert('customers', {
    id, org_id: orgId,
    first_name: lead.first_name, last_name: lead.last_name, company: lead.company,
    phone: lead.phone, email: lead.email, address: lead.address, city: lead.city,
    postal_code: lead.postal_code, region: lead.region,
    preferred_contact: lead.preferred_contact ?? 'phone',
    notes: lead.notes, owner_id: lead.owner_id,
    marketing_consent: lead.consent_marketing ? 1 : 0,
    marketing_consent_at: lead.consent_marketing ? lead.created_at : null,
    marketing_consent_source: lead.consent_marketing ? lead.intake_channel : null,
    became_customer_at: now, created_at: now, updated_at: now,
  });
  run('UPDATE leads SET customer_id = ? WHERE id = ? AND org_id = ?', [id, leadId, orgId]);
  audit({
    orgId, userId, action: 'customer.created', entityType: 'customer', entityId: id,
    entityLabel: `${lead.first_name} ${lead.last_name}`, changes: { from_lead: leadId },
  });
  return id;
}

export function inMinutes(minutes: number): string {
  return addMinutes(new Date(), minutes);
}
