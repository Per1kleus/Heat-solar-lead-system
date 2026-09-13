/**
 * Everything a new installation company starts with. These are the industry
 * defaults for a solar PV / heat-pump installer — not a generic CRM skeleton.
 */

export const DEFAULT_STAGES = [
  { key: 'new',            name: 'New',                    probability: 5,   color: '#64748b', type: 'open', stale_days: 1 },
  { key: 'contacted',      name: 'Contacted',              probability: 10,  color: '#0ea5e9', type: 'open', stale_days: 3 },
  { key: 'qualified',      name: 'Qualified',              probability: 20,  color: '#06b6d4', type: 'open', stale_days: 5 },
  { key: 'technical',      name: 'Technical Assessment',   probability: 30,  color: '#14b8a6', type: 'open', stale_days: 5 },
  { key: 'site_survey',    name: 'Site Survey',            probability: 45,  color: '#10b981', type: 'open', stale_days: 7 },
  { key: 'proposal_prep',  name: 'Proposal Preparation',   probability: 55,  color: '#84cc16', type: 'open', stale_days: 3 },
  { key: 'proposal_sent',  name: 'Proposal Sent',          probability: 65,  color: '#eab308', type: 'open', stale_days: 5 },
  { key: 'negotiation',    name: 'Negotiation',            probability: 80,  color: '#f97316', type: 'open', stale_days: 7 },
  { key: 'won',            name: 'Won',                    probability: 100, color: '#16a34a', type: 'won',  stale_days: 0 },
  { key: 'lost',           name: 'Lost',                   probability: 0,   color: '#ef4444', type: 'lost', stale_days: 0 },
] as const;

export const DEFAULT_SOURCES = [
  { key: 'website',          name: 'Website',           category: 'organic'  },
  { key: 'google_ads',       name: 'Google Ads',        category: 'paid'     },
  { key: 'facebook',         name: 'Facebook',          category: 'paid'     },
  { key: 'instagram',        name: 'Instagram',         category: 'paid'     },
  { key: 'whatsapp',         name: 'WhatsApp',          category: 'direct'   },
  { key: 'phone',            name: 'Phone call',        category: 'direct'   },
  { key: 'referral',         name: 'Referral',          category: 'referral' },
  { key: 'existing_customer',name: 'Existing customer', category: 'referral' },
  { key: 'partner',          name: 'Partner / installer',category: 'referral'},
  { key: 'manual',           name: 'Manual entry',      category: 'other'    },
  { key: 'other',            name: 'Other',             category: 'other'    },
] as const;

export const DEFAULT_LOST_REASONS = [
  { key: 'price',           name: 'Price too high',            recoverable: 1 },
  { key: 'competitor',      name: 'Chose a competitor',        recoverable: 1 },
  { key: 'not_interested',  name: 'Not interested',            recoverable: 0 },
  { key: 'postponed',       name: 'Project postponed',         recoverable: 1 },
  { key: 'financing',       name: 'Financing not available',   recoverable: 1 },
  { key: 'no_contact',      name: 'Unable to contact',         recoverable: 1 },
  { key: 'technical',       name: 'Technical limitation',      recoverable: 0 },
  { key: 'other',           name: 'Other',                     recoverable: 1 },
] as const;

/**
 * Scoring factors. `key` maps to an evaluator in lib/scoring.ts; `points` and
 * `config` are editable per organisation from Settings → Lead scoring.
 */
export const DEFAULT_SCORING_RULES = [
  { key: 'requested_quote',    label: 'Requested a quotation',            points: 25, config: {} },
  { key: 'high_value',         label: 'High estimated project value',     points: 20, config: { threshold: 8000 } },
  { key: 'responded',          label: 'Responded to the salesperson',     points: 15, config: {} },
  { key: 'survey_booked',      label: 'Site survey booked',               points: 15, config: {} },
  { key: 'info_complete',      label: 'Complete project information',     points: 12, config: { required: 5 } },
  { key: 'high_consumption',   label: 'High electricity consumption',     points: 10, config: { threshold: 8000 } },
  { key: 'high_heating_cost',  label: 'High annual heating cost',         points: 10, config: { threshold: 1500 } },
  { key: 'urgency',            label: 'Wants to proceed immediately',     points: 12, config: {} },
  { key: 'budget_known',       label: 'Budget confirmed',                 points: 8,  config: {} },
  { key: 'multi_product',      label: 'Interested in more than one product', points: 8, config: {} },
  { key: 'quality_source',     label: 'Came from a high-converting source', points: 6, config: { sources: ['referral', 'existing_customer', 'website'] } },
  { key: 'reachable',          label: 'Phone and email both provided',    points: 5,  config: {} },
  { key: 'stale',              label: 'No activity recently',             points: -20, config: { days: 7 } },
  { key: 'unreachable',        label: 'Repeated failed contact attempts', points: -15, config: { attempts: 3 } },
] as const;

export const TEMPERATURE_BANDS = { hot: 80, warm: 50 };

export function temperatureFor(score: number): 'hot' | 'warm' | 'cold' {
  if (score >= TEMPERATURE_BANDS.hot) return 'hot';
  if (score >= TEMPERATURE_BANDS.warm) return 'warm';
  return 'cold';
}

export const DEFAULT_TEMPLATES = [
  {
    key: 'lead_acknowledgement',
    name: 'Lead acknowledgement',
    channel: 'email',
    purpose: 'operational',
    subject: 'We received your enquiry — {{company.name}}',
    body: `Hello {{lead.first_name}},

Thank you for your enquiry about {{lead.project_summary}}.

We have received your details and one of our engineers will contact you shortly to discuss your requirements and arrange the next steps.

If anything is urgent you can reach us on {{company.phone}}.

Kind regards,
{{company.name}}
{{company.website}}`,
  },
  {
    key: 'quote_sent',
    name: 'Quotation sent',
    channel: 'email',
    purpose: 'operational',
    subject: 'Your quotation {{quote.number}} from {{company.name}}',
    body: `Hello {{lead.first_name}},

Please find attached our quotation {{quote.number}} for {{quote.title}}.

Total: {{quote.total}}
Valid until: {{quote.valid_until}}

I am happy to walk you through the proposal and answer any questions.

Kind regards,
{{user.first_name}} {{user.last_name}}
{{company.name}} — {{company.phone}}`,
  },
  {
    key: 'quote_follow_up',
    name: 'Quotation follow-up',
    channel: 'email',
    purpose: 'operational',
    subject: 'Following up on quotation {{quote.number}}',
    body: `Hello {{lead.first_name}},

I wanted to check whether you had a chance to review quotation {{quote.number}} and whether any part of it needs clarification.

Happy to adjust the scope or discuss alternatives if that helps.

Kind regards,
{{user.first_name}} {{user.last_name}}
{{company.name}}`,
  },
  {
    key: 'survey_confirmation',
    name: 'Site survey confirmation',
    channel: 'email',
    purpose: 'operational',
    subject: 'Site survey confirmed — {{appointment.date}}',
    body: `Hello {{lead.first_name}},

Your technical site survey is confirmed for {{appointment.date}} at {{lead.address}}.

Our technician will need access to the roof area and the electrical panel. The visit usually takes 45–60 minutes.

Kind regards,
{{company.name}}`,
  },
] as const;

/** The eight automation rules from the product spec, created active by default. */
export const DEFAULT_AUTOMATION_RULES = [
  {
    key: 'new_lead',
    name: 'New lead — assign, notify, first follow-up',
    description: 'Assigns the lead using your assignment rules, notifies the owner and creates the first follow-up task. Sends the acknowledgement email only when email is connected and a legal basis exists.',
    trigger_type: 'lead_created',
    steps: [
      { delay_minutes: 0, actions: [
        { type: 'notify_owner', notification_type: 'lead_assigned', title: 'New lead assigned to you', severity: 'info' },
        { type: 'create_task', title: 'First contact: call {{lead.full_name}}', task_type: 'call', priority: 'high', due_in_minutes: 30 },
        { type: 'send_template', template_key: 'lead_acknowledgement', channel: 'email', purpose: 'operational' },
      ] },
      { delay_minutes: 30, stop_if: ['contacted'], actions: [
        { type: 'notify_owner', notification_type: 'task_due', severity: 'warning', title: 'Lead not contacted yet', body: '{{lead.full_name}} arrived 30 minutes ago and has not been contacted.' },
      ] },
      { delay_minutes: 1440, stop_if: ['contacted'], actions: [
        { type: 'create_task', title: 'Day 1 follow-up: {{lead.full_name}}', task_type: 'follow_up', priority: 'high' },
      ] },
      { delay_minutes: 4320, stop_if: ['contacted'], actions: [
        { type: 'create_task', title: 'Day 3 follow-up: {{lead.full_name}}', task_type: 'follow_up', priority: 'normal' },
      ] },
      { delay_minutes: 10080, stop_if: ['contacted'], actions: [
        { type: 'create_task', title: 'Day 7 follow-up: {{lead.full_name}}', task_type: 'follow_up', priority: 'normal' },
      ] },
      { delay_minutes: 20160, stop_if: ['contacted'], actions: [
        { type: 'create_task', title: 'Final follow-up before archiving: {{lead.full_name}}', task_type: 'follow_up', priority: 'low' },
      ] },
    ],
    stop_on: ['customer_replied', 'appointment_booked', 'won', 'lost', 'paused'],
  },
  {
    key: 'no_contact',
    name: 'Lead untouched — alert the salesperson',
    description: 'If an open lead has had no activity for the configured number of hours, the owner is alerted.',
    trigger_type: 'lead_idle',
    trigger_config: { hours: 24 },
    steps: [{ delay_minutes: 0, actions: [
      { type: 'notify_owner', notification_type: 'lead_idle', severity: 'warning', title: 'Lead has had no activity', body: '{{lead.full_name}} ({{lead.value}}) has had no activity for 24 hours.' },
    ] }],
    stop_on: ['won', 'lost'],
  },
  {
    key: 'hot_lead',
    name: 'Lead becomes Hot — notify immediately',
    description: 'When a lead crosses the Hot threshold, the owner and the sales manager are notified.',
    trigger_type: 'temperature_changed',
    trigger_config: { to: 'hot' },
    steps: [{ delay_minutes: 0, actions: [
      { type: 'notify_owner', notification_type: 'hot_lead', severity: 'critical', title: '🔥 Hot lead: {{lead.full_name}}', body: 'Score {{lead.score}} · {{lead.value}} estimated. Contact today.' },
      { type: 'notify_managers', notification_type: 'hot_lead', severity: 'info', title: 'Hot lead in the pipeline', body: '{{lead.full_name}} — {{lead.value}}' },
    ] }],
    stop_on: ['won', 'lost'],
  },
  {
    key: 'quote_sent',
    name: 'Quotation sent — follow-up sequence',
    description: 'Day 2 reminder, then follow-ups on day 5, 10 and a final one on day 20. Stops as soon as the customer responds.',
    trigger_type: 'quote_sent',
    steps: [
      { delay_minutes: 2880,  actions: [{ type: 'create_task', title: 'Check quotation {{quote.number}} was received', task_type: 'call', priority: 'normal' }] },
      { delay_minutes: 7200,  actions: [{ type: 'create_task', title: 'Follow up on quotation {{quote.number}} ({{quote.total}})', task_type: 'follow_up', priority: 'high' }] },
      { delay_minutes: 14400, actions: [{ type: 'create_task', title: 'Second follow-up on quotation {{quote.number}}', task_type: 'follow_up', priority: 'high' }] },
      { delay_minutes: 28800, actions: [
        { type: 'create_task', title: 'Final follow-up on quotation {{quote.number}}', task_type: 'follow_up', priority: 'normal' },
        { type: 'notify_owner', notification_type: 'quote_stale', severity: 'warning', title: 'Quotation still unanswered', body: '{{quote.number}} — {{quote.total}} has had no response for 20 days.' },
      ] },
    ],
    stop_on: ['quote_responded', 'won', 'lost', 'paused'],
  },
  {
    key: 'overdue_task',
    name: 'Follow-up overdue — notify the assignee',
    description: 'Raises a notification the moment a follow-up task passes its due date.',
    trigger_type: 'task_overdue',
    steps: [{ delay_minutes: 0, actions: [
      { type: 'notify_assignee', notification_type: 'task_overdue', severity: 'critical', title: 'Follow-up overdue', body: '{{task.title}} was due {{task.due_human}}.' },
    ] }],
    stop_on: [],
  },
  {
    key: 'lost_recovery',
    name: 'Lost lead — schedule recovery',
    description: 'When a lost lead has a recovery date, a recovery task is created for that date automatically.',
    trigger_type: 'lead_lost',
    steps: [{ delay_minutes: 0, actions: [{ type: 'schedule_recovery' }] }],
    stop_on: [],
  },
  {
    key: 'won_handoff',
    name: 'Deal won — record revenue and hand over to installation',
    description: 'Stops active sales sequences, creates the project record and opens the installation handover task.',
    trigger_type: 'lead_won',
    steps: [{ delay_minutes: 0, actions: [
      { type: 'stop_sales_automations' },
      { type: 'create_task', title: 'Installation handover: {{lead.full_name}}', task_type: 'post_sale', priority: 'high', due_in_minutes: 2880 },
      { type: 'notify_managers', notification_type: 'deal_won', severity: 'success', title: '💰 Deal won — {{lead.value}}', body: '{{lead.full_name}} · {{lead.project_summary}}' },
    ] }],
    stop_on: [],
  },
  {
    key: 'no_next_action',
    name: 'Active lead without a next action — flag it',
    description: 'Any open lead with no scheduled next action is flagged on the dashboard and the owner is notified once per day.',
    trigger_type: 'no_next_action',
    steps: [{ delay_minutes: 0, actions: [
      { type: 'notify_owner', notification_type: 'no_next_action', severity: 'warning', title: 'Lead has no next action', body: '{{lead.full_name}} is open but nothing is scheduled.' },
    ] }],
    stop_on: ['won', 'lost'],
  },
] as const;

export const DEFAULT_PRODUCTS = [
  { project_type: 'pv', category: 'equipment',    name: 'PV module 450 Wp (monocrystalline)', unit: 'pcs', unit_price: 95 },
  { project_type: 'pv', category: 'equipment',    name: 'Hybrid inverter 10 kW',              unit: 'pcs', unit_price: 1850 },
  { project_type: 'pv', category: 'equipment',    name: 'Mounting structure (tiled roof)',    unit: 'kWp', unit_price: 85 },
  { project_type: 'pv', category: 'equipment',    name: 'DC/AC protection kit',               unit: 'set', unit_price: 320 },
  { project_type: 'pv', category: 'equipment',    name: 'Monitoring gateway',                 unit: 'pcs', unit_price: 180 },
  { project_type: 'pv', category: 'installation', name: 'Mechanical installation',            unit: 'kWp', unit_price: 120 },
  { project_type: 'pv', category: 'electrical',   name: 'Electrical works and cabling',       unit: 'kWp', unit_price: 95 },
  { project_type: 'pv', category: 'service',      name: 'Grid connection paperwork',          unit: 'job', unit_price: 350 },
  { project_type: 'pv', category: 'service',      name: 'Annual maintenance (year 1)',        unit: 'yr',  unit_price: 180 },
  { project_type: 'battery', category: 'equipment',    name: 'LFP battery 10 kWh',            unit: 'pcs', unit_price: 3400 },
  { project_type: 'battery', category: 'installation', name: 'Battery installation & commissioning', unit: 'job', unit_price: 480 },
  { project_type: 'battery', category: 'equipment',    name: 'Backup / EPS changeover box',   unit: 'pcs', unit_price: 620 },
  { project_type: 'heat_pump', category: 'equipment',    name: 'Air-to-water heat pump 12 kW', unit: 'pcs', unit_price: 6200 },
  { project_type: 'heat_pump', category: 'equipment',    name: 'Buffer tank 100 L',            unit: 'pcs', unit_price: 480 },
  { project_type: 'heat_pump', category: 'equipment',    name: 'DHW cylinder 200 L',           unit: 'pcs', unit_price: 940 },
  { project_type: 'heat_pump', category: 'installation', name: 'Hydraulic installation',       unit: 'job', unit_price: 1450 },
  { project_type: 'heat_pump', category: 'electrical',   name: 'Electrical installation & controls', unit: 'job', unit_price: 620 },
  { project_type: 'heat_pump', category: 'installation', name: 'Removal of existing boiler',   unit: 'job', unit_price: 380 },
  { project_type: 'heat_pump', category: 'service',      name: 'Commissioning & handover',     unit: 'job', unit_price: 250 },
  { project_type: 'ev_charger', category: 'equipment',    name: 'EV charger 22 kW (3-phase)',  unit: 'pcs', unit_price: 780 },
  { project_type: 'ev_charger', category: 'installation', name: 'EV charger installation',     unit: 'job', unit_price: 420 },
] as const;

export const PLANS = {
  trial: {
    key: 'trial', name: 'Trial', price_eur: 0, seats: 3, lead_limit: 100,
    features: ['pipeline', 'quotations', 'automation_basic', 'analytics', 'site_surveys', 'ai'],
    description: '14 days, full Growth feature set.',
  },
  starter: {
    key: 'starter', name: 'Starter', price_eur: 79, seats: 2, lead_limit: 250,
    features: ['pipeline', 'quotations', 'automation_basic'],
    description: 'For a small team getting every lead under control.',
  },
  growth: {
    key: 'growth', name: 'Growth', price_eur: 149, seats: 5, lead_limit: 1000,
    features: ['pipeline', 'quotations', 'automation_basic', 'automation_advanced', 'analytics', 'site_surveys', 'integrations'],
    description: 'Advanced automation, analytics and site surveys.',
  },
  pro: {
    key: 'pro', name: 'Pro', price_eur: 249, seats: 15, lead_limit: 25000,
    features: ['pipeline', 'quotations', 'automation_basic', 'automation_advanced', 'analytics', 'analytics_advanced', 'site_surveys', 'integrations', 'ai', 'api'],
    description: 'Everything, including AI assistance and the open API.',
  },
} as const;

export type PlanKey = keyof typeof PLANS;
export type Feature = (typeof PLANS)[PlanKey]['features'][number];

export const PROJECT_TYPES = [
  { key: 'pv',          label: 'Photovoltaic system' },
  { key: 'heat_pump',   label: 'Heat pump' },
  { key: 'battery',     label: 'Battery storage' },
  { key: 'ev_charger',  label: 'EV charger' },
  { key: 'other',       label: 'Something else' },
] as const;
