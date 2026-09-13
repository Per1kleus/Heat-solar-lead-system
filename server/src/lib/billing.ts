import { get, parseJson } from './db.ts';
import { PLANS, type PlanKey } from './defaults.ts';
import { limitReached } from './errors.ts';

export interface SubscriptionState {
  plan: PlanKey;
  status: string;
  price_eur: number;
  seats: number;
  lead_limit: number;
  features: string[];
  trial_ends_at: string | null;
  period_start: string;
  period_end: string;
  usage: { leads_this_period: number; seats_used: number; ai_calls: number };
  limits: { leads_pct: number; seats_pct: number };
}

export function getSubscription(orgId: string): SubscriptionState {
  const row = get<any>('SELECT * FROM subscriptions WHERE org_id = ?', [orgId]);
  const plan = (row?.plan ?? 'trial') as PlanKey;
  const fallback = PLANS[plan];
  const period = new Date().toISOString().slice(0, 7);
  const leads = get<{ value: number }>(
    'SELECT value FROM usage_counters WHERE org_id = ? AND period = ? AND metric = ?',
    [orgId, period, 'leads_created'],
  )?.value ?? 0;
  const aiCalls = get<{ value: number }>(
    'SELECT value FROM usage_counters WHERE org_id = ? AND period = ? AND metric = ?',
    [orgId, period, 'ai_calls'],
  )?.value ?? 0;
  const seatsUsed = get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM users WHERE org_id = ? AND status IN ('active','invited')", [orgId],
  )?.n ?? 0;

  const leadLimit = row?.lead_limit ?? fallback.lead_limit;
  const seats = row?.seats ?? fallback.seats;
  return {
    plan,
    status: row?.status ?? 'trialing',
    price_eur: row?.price_eur ?? fallback.price_eur,
    seats,
    lead_limit: leadLimit,
    features: parseJson<string[]>(row?.features, [...fallback.features]),
    trial_ends_at: row?.trial_ends_at ?? null,
    period_start: row?.period_start ?? new Date().toISOString(),
    period_end: row?.period_end ?? new Date().toISOString(),
    usage: { leads_this_period: leads, seats_used: seatsUsed, ai_calls: aiCalls },
    limits: {
      leads_pct: leadLimit > 0 ? Math.round((leads / leadLimit) * 100) : 0,
      seats_pct: seats > 0 ? Math.round((seatsUsed / seats) * 100) : 0,
    },
  };
}

export function hasFeature(orgId: string, feature: string): boolean {
  return getSubscription(orgId).features.includes(feature);
}

export function requireFeature(orgId: string, feature: string, label: string): void {
  const sub = getSubscription(orgId);
  if (sub.features.includes(feature)) return;
  const upgrade = (Object.keys(PLANS) as PlanKey[]).find((key) => (PLANS[key].features as readonly string[]).includes(feature));
  throw limitReached(
    `${label} is not included in the ${PLANS[sub.plan].name} plan.${upgrade ? ` Upgrade to ${PLANS[upgrade].name} to enable it.` : ''}`,
    { feature, current_plan: sub.plan, upgrade_to: upgrade },
  );
}

/** Called before creating a lead. Blocks only when the monthly allowance is spent. */
export function assertLeadAllowance(orgId: string): void {
  const sub = getSubscription(orgId);
  if (sub.status === 'cancelled') {
    throw limitReached('This subscription has been cancelled. Reactivate a plan to keep capturing leads.');
  }
  if (sub.lead_limit > 0 && sub.usage.leads_this_period >= sub.lead_limit) {
    throw limitReached(
      `You have reached the ${sub.lead_limit.toLocaleString()} lead limit for the ${PLANS[sub.plan].name} plan this month. Upgrade to keep capturing leads.`,
      { limit: sub.lead_limit, used: sub.usage.leads_this_period },
    );
  }
}

export function assertSeatAllowance(orgId: string): void {
  const sub = getSubscription(orgId);
  if (sub.usage.seats_used >= sub.seats) {
    throw limitReached(
      `The ${PLANS[sub.plan].name} plan includes ${sub.seats} users. Upgrade to add more of your team.`,
      { limit: sub.seats, used: sub.usage.seats_used },
    );
  }
}
