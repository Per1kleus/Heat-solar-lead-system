import { all, get, insert, run } from './db.ts';
import { newId, randomToken, slugify } from './ids.ts';
import { addDays, nowIso } from './time.ts';
import { hashPassword } from './auth.ts';
import {
  DEFAULT_AUTOMATION_RULES, DEFAULT_LOST_REASONS, DEFAULT_PRODUCTS, DEFAULT_SCORING_RULES,
  DEFAULT_SOURCES, DEFAULT_STAGES, DEFAULT_TEMPLATES, OPTIONAL_AUTOMATION_RULES, PLANS, type PlanKey,
} from './defaults.ts';
import { audit } from './audit.ts';
import { conflict } from './errors.ts';

const AVATAR_COLORS = ['#0d9488', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#0891b2', '#65a30d'];

export interface SignupInput {
  companyName: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
  phone?: string;
  services?: string[];
}

export function provisionOrganization(input: SignupInput): { orgId: string; userId: string } {
  const email = input.email.trim().toLowerCase();
  const existing = get<{ id: string }>('SELECT id FROM users WHERE email = ?', [email]);
  if (existing) throw conflict('An account with that email address already exists. Sign in instead.');

  const orgId = newId('org');
  const userId = newId('usr');
  const now = nowIso();
  const slug = uniqueSlug(slugify(input.companyName));

  insert('organizations', {
    id: orgId,
    name: input.companyName.trim(),
    slug,
    email,
    phone: input.phone ?? null,
    services: JSON.stringify(input.services ?? ['pv', 'heat_pump']),
    public_form_token: randomToken(16),
    quote_terms: DEFAULT_QUOTE_TERMS,
    created_at: now,
    updated_at: now,
  });

  insert('users', {
    id: userId,
    org_id: orgId,
    email,
    password_hash: hashPassword(input.password),
    first_name: input.firstName.trim(),
    last_name: input.lastName.trim(),
    phone: input.phone ?? null,
    avatar_color: AVATAR_COLORS[0],
    role: 'owner',
    status: 'active',
    created_at: now,
    updated_at: now,
  });

  seedOrganizationDefaults(orgId, userId);
  startSubscription(orgId, 'trial');
  audit({ orgId, userId, action: 'org.created', entityType: 'organization', entityId: orgId, entityLabel: input.companyName });
  return { orgId, userId };
}

function uniqueSlug(base: string): string {
  let slug = base;
  for (let i = 2; i < 200; i += 1) {
    if (!get('SELECT 1 FROM organizations WHERE slug = ?', [slug])) return slug;
    slug = `${base}-${i}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export function seedOrganizationDefaults(orgId: string, userId: string | null): void {
  const now = nowIso();

  DEFAULT_STAGES.forEach((stage, index) => {
    insert('pipeline_stages', {
      id: newId('stg'), org_id: orgId, key: stage.key, name: stage.name, position: index,
      probability: stage.probability, color: stage.color, type: stage.type,
      stale_days: stage.stale_days, created_at: now,
    });
  });

  DEFAULT_SOURCES.forEach((source) => {
    insert('lead_sources', {
      id: newId('src'), org_id: orgId, key: source.key, name: source.name,
      category: source.category, is_system: 1, created_at: now,
    });
  });

  DEFAULT_LOST_REASONS.forEach((reason, index) => {
    insert('lost_reasons', {
      id: newId('lrs'), org_id: orgId, key: reason.key, name: reason.name,
      recoverable: reason.recoverable, position: index, created_at: now,
    });
  });

  DEFAULT_SCORING_RULES.forEach((rule, index) => {
    insert('scoring_rules', {
      id: newId('scr'), org_id: orgId, key: rule.key, label: rule.label,
      points: rule.points, config: JSON.stringify(rule.config), position: index,
    });
  });

  insert('assignment_rules', {
    id: newId('asr'), org_id: orgId, name: 'Round-robin across the sales team',
    position: 0, conditions: '[]', strategy: 'round_robin', created_at: now,
  });

  syncOrgDefaults(orgId, userId);

  DEFAULT_PRODUCTS.forEach((product) => {
    insert('product_templates', {
      id: newId('prd'), org_id: orgId, project_type: product.project_type, category: product.category,
      name: product.name, unit: product.unit, unit_price: product.unit_price, created_at: now,
    });
  });

  for (const provider of ['smtp', 'whatsapp_cloud', 'meta_lead_ads', 'google_ads', 'telephony', 'anthropic']) {
    insert('integrations', {
      id: newId('int'), org_id: orgId, provider, status: 'disconnected',
      config: '{}', secrets: '{}', created_at: now, updated_at: now,
    });
  }
}

export function startSubscription(orgId: string, planKey: PlanKey): void {
  const plan = PLANS[planKey];
  const now = nowIso();
  const periodEnd = addDays(new Date(), planKey === 'trial' ? 14 : 30);
  const existing = get<{ id: string }>('SELECT id FROM subscriptions WHERE org_id = ?', [orgId]);
  if (existing) {
    run(
      `UPDATE subscriptions SET plan = ?, status = ?, price_eur = ?, seats = ?, lead_limit = ?, features = ?,
         period_start = ?, period_end = ?, trial_ends_at = ?, cancelled_at = NULL, updated_at = ?
       WHERE org_id = ?`,
      [
        planKey, planKey === 'trial' ? 'trialing' : 'active', plan.price_eur, plan.seats, plan.lead_limit,
        JSON.stringify(plan.features), now, periodEnd, planKey === 'trial' ? periodEnd : null, now, orgId,
      ],
    );
    return;
  }
  insert('subscriptions', {
    id: newId('sub'), org_id: orgId, plan: planKey,
    status: planKey === 'trial' ? 'trialing' : 'active',
    price_eur: plan.price_eur, seats: plan.seats, lead_limit: plan.lead_limit,
    features: JSON.stringify(plan.features),
    trial_ends_at: planKey === 'trial' ? periodEnd : null,
    period_start: now, period_end: periodEnd, created_at: now, updated_at: now,
  });
}

export const DEFAULT_QUOTE_TERMS = `1. This quotation is valid until the date shown above.
2. Prices include VAT at the rate shown and are based on the information provided by the customer.
3. A technical site survey may adjust the scope; any change is agreed in writing before work starts.
4. Payment terms: 40% on order, 50% on delivery of equipment, 10% on commissioning.
5. Equipment carries the manufacturer's warranty; installation workmanship is warranted for 2 years.
6. Grid connection and permitting timescales depend on the network operator and are outside our control.`;

export function nextAvatarColor(orgId: string): string {
  const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM users WHERE org_id = ?', [orgId])?.n ?? 0;
  return AVATAR_COLORS[count % AVATAR_COLORS.length];
}

/**
 * Creates any default template or automation rule the organisation does not have
 * yet. Called when a company signs up, and once on boot for every existing
 * company, so a new default that ships in an upgrade reaches them too. Existing
 * rows are never touched — an installer who reworded a template or switched a
 * rule off keeps their version.
 */
export function syncOrgDefaults(orgId: string, userId: string | null = null): { templates: number; rules: number } {
  const now = nowIso();
  let templates = 0;
  let rules = 0;

  for (const template of DEFAULT_TEMPLATES) {
    if (get('SELECT 1 FROM message_templates WHERE org_id = ? AND key = ?', [orgId, template.key])) continue;
    insert('message_templates', {
      id: newId('tpl'), org_id: orgId, key: template.key, name: template.name,
      channel: template.channel, purpose: template.purpose, subject: template.subject,
      body: template.body, created_at: now, updated_at: now,
    });
    templates += 1;
  }

  const creator = userId ?? get<{ id: string }>(
    "SELECT id FROM users WHERE org_id = ? AND role IN ('owner','admin') ORDER BY created_at LIMIT 1", [orgId],
  )?.id ?? null;

  const seed = (rule: any, active: boolean) => {
    if (get('SELECT 1 FROM automation_rules WHERE org_id = ? AND key = ?', [orgId, rule.key])) return;
    insert('automation_rules', {
      id: newId('aut'), org_id: orgId, key: rule.key, name: rule.name,
      description: rule.description, trigger_type: rule.trigger_type,
      trigger_config: JSON.stringify(rule.trigger_config ?? {}),
      conditions: '[]', steps: JSON.stringify(rule.steps), stop_on: JSON.stringify(rule.stop_on),
      is_active: active ? 1 : 0, is_system: 1, created_by: creator, created_at: now, updated_at: now,
    });
    rules += 1;
  };
  DEFAULT_AUTOMATION_RULES.forEach((rule) => seed(rule, true));
  // Customer-facing sequences arrive switched off — see OPTIONAL_AUTOMATION_RULES.
  OPTIONAL_AUTOMATION_RULES.forEach((rule) => seed(rule, false));

  return { templates, rules };
}

/** Brings every organisation up to the current defaults. Runs once at startup. */
export function syncAllOrgDefaults(): void {
  for (const org of all<{ id: string }>('SELECT id FROM organizations')) {
    try {
      syncOrgDefaults(org.id);
    } catch (err) {
      console.error('[provision] could not sync defaults for', org.id, err);
    }
  }
}
