import { all, get, parseJson } from './db.ts';
import { temperatureFor } from './defaults.ts';
import { hoursBetween, daysBetween } from './time.ts';

export interface ScoreFactor {
  key: string;
  label: string;
  points: number;
  detail?: string;
}

export interface ScoreResult {
  score: number;
  temperature: 'hot' | 'warm' | 'cold';
  breakdown: ScoreFactor[];
  missing: string[];
}

interface Rule { key: string; label: string; points: number; config: Record<string, any>; is_active: number }

/** Signals gathered once per scoring pass so each evaluator stays cheap. */
export interface ScoringSignals {
  quotesSent: number;
  customerReplies: number;
  outboundAttempts: number;
  failedAttempts: number;
  surveysBooked: number;
  appointmentsBooked: number;
  hoursSinceActivity: number | null;
}

export function gatherSignals(orgId: string, leadId: string, lastActivityAt: string | null): ScoringSignals {
  const quotes = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM quotations WHERE org_id = ? AND lead_id = ? AND status != 'draft'",
    [orgId, leadId],
  );
  const acts = all<{ type: string; direction: string; outcome: string | null; n: number }>(
    `SELECT type, direction, outcome, COUNT(*) AS n FROM activities
     WHERE org_id = ? AND lead_id = ? GROUP BY type, direction, outcome`,
    [orgId, leadId],
  );
  let customerReplies = 0, outboundAttempts = 0, failedAttempts = 0;
  for (const a of acts) {
    const isComms = ['call', 'email', 'whatsapp', 'sms', 'meeting'].includes(a.type);
    if (!isComms) continue;
    if (a.direction === 'inbound') customerReplies += a.n;
    else if (a.direction === 'outbound') {
      outboundAttempts += a.n;
      if (a.outcome === 'no_answer' || a.outcome === 'voicemail') failedAttempts += a.n;
    }
  }
  const surveys = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM site_surveys WHERE org_id = ? AND lead_id = ? AND status != 'cancelled'",
    [orgId, leadId],
  );
  const appts = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM appointments WHERE org_id = ? AND lead_id = ? AND status != 'cancelled'",
    [orgId, leadId],
  );
  return {
    quotesSent: quotes?.n ?? 0,
    customerReplies,
    outboundAttempts,
    failedAttempts,
    surveysBooked: surveys?.n ?? 0,
    appointmentsBooked: appts?.n ?? 0,
    hoursSinceActivity: lastActivityAt ? hoursBetween(lastActivityAt) : null,
  };
}

type Evaluator = (lead: any, cfg: Record<string, any>, s: ScoringSignals) => { hit: boolean; detail?: string };

const EVALUATORS: Record<string, Evaluator> = {
  requested_quote: (lead, _c, s) => ({
    hit: s.quotesSent > 0 || Boolean(lead.requested_quote),
    detail: s.quotesSent > 0 ? `${s.quotesSent} quotation(s) issued` : 'quotation requested on the enquiry',
  }),
  high_value: (lead, cfg) => ({
    hit: Number(lead.estimated_value) >= Number(cfg.threshold ?? 8000),
    detail: `estimated ${fmt(lead.estimated_value)}`,
  }),
  responded: (_l, _c, s) => ({ hit: s.customerReplies > 0, detail: `${s.customerReplies} inbound reply(ies)` }),
  survey_booked: (_l, _c, s) => ({ hit: s.surveysBooked > 0 || s.appointmentsBooked > 0, detail: 'site visit scheduled' }),
  info_complete: (lead, cfg) => {
    const filled = countCompleteness(lead).filled;
    return { hit: filled >= Number(cfg.required ?? 5), detail: `${filled} technical fields provided` };
  },
  high_consumption: (lead, cfg) => ({
    hit: Number(lead.pv_annual_kwh ?? 0) >= Number(cfg.threshold ?? 8000),
    detail: lead.pv_annual_kwh ? `${Math.round(lead.pv_annual_kwh).toLocaleString()} kWh/year` : undefined,
  }),
  high_heating_cost: (lead, cfg) => ({
    hit: Number(lead.hp_annual_heating_cost ?? 0) >= Number(cfg.threshold ?? 1500),
    detail: lead.hp_annual_heating_cost ? `${fmt(lead.hp_annual_heating_cost)} per year on heating` : undefined,
  }),
  urgency: (lead) => ({ hit: lead.urgency === 'immediate', detail: 'wants to start immediately' }),
  budget_known: (lead) => ({ hit: Boolean(lead.budget_known), detail: lead.budget_amount ? fmt(lead.budget_amount) : undefined }),
  multi_product: (lead) => {
    const types = parseJson<string[]>(lead.project_types, []);
    const extras = [lead.battery_interest, lead.ev_charger_interest, lead.backup_power_interest].filter(Boolean).length;
    return { hit: types.length > 1 || extras > 0, detail: types.join(' + ') || undefined };
  },
  quality_source: (lead, cfg) => ({
    hit: Array.isArray(cfg.sources) && cfg.sources.includes(lead.source_key),
    detail: lead.source_name ?? undefined,
  }),
  reachable: (lead) => ({ hit: Boolean(lead.phone) && Boolean(lead.email) }),
  stale: (lead, cfg, s) => ({
    hit: lead.status === 'open' && s.hoursSinceActivity !== null && s.hoursSinceActivity > Number(cfg.days ?? 7) * 24,
    detail: lead.last_activity_at ? `${daysBetween(lead.last_activity_at)} days since last activity` : undefined,
  }),
  unreachable: (_l, cfg, s) => ({
    hit: s.failedAttempts >= Number(cfg.attempts ?? 3),
    detail: `${s.failedAttempts} attempts without an answer`,
  }),
};

/** Technical fields that make a lead quotable — also drives the AI "missing info" list. */
const COMPLETENESS_FIELDS: { field: string; label: string; when?: (lead: any) => boolean }[] = [
  { field: 'phone', label: 'phone number' },
  { field: 'email', label: 'email address' },
  { field: 'city', label: 'city' },
  { field: 'address', label: 'installation address' },
  { field: 'pv_annual_kwh', label: 'annual electricity consumption', when: (l) => isPv(l) },
  { field: 'pv_monthly_bill', label: 'monthly electricity bill', when: (l) => isPv(l) },
  { field: 'pv_roof_type', label: 'roof type', when: (l) => isPv(l) },
  { field: 'pv_roof_orientation', label: 'roof orientation', when: (l) => isPv(l) },
  { field: 'pv_roof_area_m2', label: 'available roof area', when: (l) => isPv(l) },
  { field: 'pv_phase', label: 'single or three-phase supply', when: (l) => isPv(l) },
  { field: 'pv_property_type', label: 'property type', when: (l) => isPv(l) },
  { field: 'hp_property_m2', label: 'property size in m²', when: (l) => isHp(l) },
  { field: 'hp_existing_system', label: 'existing heating system', when: (l) => isHp(l) },
  { field: 'hp_emitters', label: 'radiators or underfloor heating', when: (l) => isHp(l) },
  { field: 'hp_annual_heating_cost', label: 'current annual heating cost', when: (l) => isHp(l) },
  { field: 'hp_insulation', label: 'insulation condition', when: (l) => isHp(l) },
  { field: 'hp_floors', label: 'number of floors', when: (l) => isHp(l) },
];

function isPv(lead: any): boolean {
  const types = parseJson<string[]>(lead.project_types, []);
  return Boolean(lead.pv_interest) || types.includes('pv') || types.includes('battery');
}
function isHp(lead: any): boolean {
  const types = parseJson<string[]>(lead.project_types, []);
  return Boolean(lead.hp_interest) || types.includes('heat_pump');
}

export function countCompleteness(lead: any): { filled: number; total: number; missing: string[] } {
  const relevant = COMPLETENESS_FIELDS.filter((f) => !f.when || f.when(lead));
  const missing: string[] = [];
  let filled = 0;
  for (const f of relevant) {
    const value = lead[f.field];
    if (value === null || value === undefined || value === '' || value === 0) missing.push(f.label);
    else filled += 1;
  }
  return { filled, total: relevant.length, missing };
}

export function loadRules(orgId: string): Rule[] {
  const rows = all<any>('SELECT * FROM scoring_rules WHERE org_id = ? ORDER BY position, key', [orgId]);
  return rows.map((r) => ({ ...r, config: parseJson<Record<string, any>>(r.config, {}) }));
}

/**
 * Compute a lead's score. Pure given (lead, rules, signals) so it can be unit
 * tested and previewed in Settings without touching the database.
 */
export function computeScore(lead: any, rules: Rule[], signals: ScoringSignals): ScoreResult {
  const breakdown: ScoreFactor[] = [];
  let score = 0;
  for (const rule of rules) {
    if (!rule.is_active) continue;
    const evaluator = EVALUATORS[rule.key];
    if (!evaluator) continue;
    const { hit, detail } = evaluator(lead, rule.config, signals);
    if (!hit) continue;
    score += rule.points;
    breakdown.push({ key: rule.key, label: rule.label, points: rule.points, detail });
  }
  score = Math.max(0, Math.min(100, score));
  breakdown.sort((a, b) => b.points - a.points);
  return {
    score,
    temperature: temperatureFor(score),
    breakdown,
    missing: countCompleteness(lead).missing,
  };
}

function fmt(value: unknown): string {
  const n = Number(value ?? 0);
  return `€${n.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
}

export const SCORING_EVALUATOR_KEYS = Object.keys(EVALUATORS);
