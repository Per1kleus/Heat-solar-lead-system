-- VoltaFlow schema
-- Multi-tenant lead & sales platform for solar PV / heat-pump installers.
-- Every tenant-owned row carries org_id; all access goes through the tenant-scoped
-- repository helpers in src/lib/db.ts which require an org_id on every statement.

PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────── tenancy & identity

CREATE TABLE IF NOT EXISTS organizations (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL UNIQUE,
  logo_url          TEXT,
  address           TEXT,
  city              TEXT,
  postal_code       TEXT,
  country           TEXT DEFAULT 'GR',
  phone             TEXT,
  email             TEXT,
  website           TEXT,
  vat_number        TEXT,
  tax_office        TEXT,
  registry_number   TEXT,
  currency          TEXT NOT NULL DEFAULT 'EUR',
  locale            TEXT NOT NULL DEFAULT 'en',
  timezone          TEXT NOT NULL DEFAULT 'Europe/Athens',
  vat_rate          REAL NOT NULL DEFAULT 24,
  services          TEXT NOT NULL DEFAULT '[]',   -- JSON: ["pv","heat_pump","battery","ev_charger"]
  quote_prefix      TEXT NOT NULL DEFAULT 'Q',
  quote_counter     INTEGER NOT NULL DEFAULT 0,
  quote_validity_days INTEGER NOT NULL DEFAULT 30,
  quote_terms       TEXT,
  quote_footer      TEXT,
  public_form_token TEXT UNIQUE,
  api_key_hash      TEXT,
  api_key_hint      TEXT,
  onboarding_step   INTEGER NOT NULL DEFAULT 0,
  onboarding_done   INTEGER NOT NULL DEFAULT 0,
  demo_data_loaded  INTEGER NOT NULL DEFAULT 0,
  retention_months  INTEGER NOT NULL DEFAULT 0,  -- 0 = keep indefinitely
  privacy_policy_url TEXT,
  stale_lead_hours  INTEGER NOT NULL DEFAULT 48,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  phone         TEXT,
  avatar_color  TEXT NOT NULL DEFAULT '#0f766e',
  role          TEXT NOT NULL CHECK (role IN ('owner','admin','sales_manager','salesperson','technician')),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','invited','disabled')),
  capacity_weight INTEGER NOT NULL DEFAULT 1,
  notif_prefs   TEXT NOT NULL DEFAULT '{}',
  theme         TEXT NOT NULL DEFAULT 'system',
  last_login_at TEXT,
  invite_token  TEXT,
  reset_token   TEXT,
  reset_expires_at TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (org_id, email)
);
CREATE INDEX IF NOT EXISTS idx_users_org ON users(org_id, status);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  user_agent    TEXT,
  ip            TEXT,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ─────────────────────────────────────────────── sales configuration

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  name          TEXT NOT NULL,
  position      INTEGER NOT NULL,
  probability   INTEGER NOT NULL DEFAULT 0,     -- 0-100, drives weighted pipeline
  color         TEXT NOT NULL DEFAULT '#64748b',
  type          TEXT NOT NULL DEFAULT 'open' CHECK (type IN ('open','won','lost')),
  stale_days    INTEGER NOT NULL DEFAULT 7,     -- days in stage before the card is flagged
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  UNIQUE (org_id, key)
);
CREATE INDEX IF NOT EXISTS idx_stages_org ON pipeline_stages(org_id, position);

CREATE TABLE IF NOT EXISTS lead_sources (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  name          TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'other',  -- paid | organic | referral | direct | other
  cost_per_month REAL NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  is_system     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  UNIQUE (org_id, key)
);

CREATE TABLE IF NOT EXISTS lost_reasons (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  name          TEXT NOT NULL,
  recoverable   INTEGER NOT NULL DEFAULT 1,     -- offer a recovery date when chosen
  position      INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  UNIQUE (org_id, key)
);

CREATE TABLE IF NOT EXISTS scoring_rules (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,                  -- matches a factor evaluator id
  label         TEXT NOT NULL,
  points        INTEGER NOT NULL,
  config        TEXT NOT NULL DEFAULT '{}',     -- JSON thresholds
  is_active     INTEGER NOT NULL DEFAULT 1,
  position      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (org_id, key)
);

CREATE TABLE IF NOT EXISTS assignment_rules (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  position      INTEGER NOT NULL DEFAULT 0,
  conditions    TEXT NOT NULL DEFAULT '[]',     -- JSON [{field,op,value}]
  strategy      TEXT NOT NULL DEFAULT 'round_robin' CHECK (strategy IN ('round_robin','specific_user','least_open','unassigned')),
  target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_user_id  TEXT,                           -- round-robin cursor
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_fields (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity        TEXT NOT NULL DEFAULT 'lead' CHECK (entity IN ('lead','customer','project')),
  key           TEXT NOT NULL,
  label         TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('text','number','select','multiselect','boolean','date')),
  options       TEXT NOT NULL DEFAULT '[]',
  required      INTEGER NOT NULL DEFAULT 0,
  show_in_form  INTEGER NOT NULL DEFAULT 0,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  UNIQUE (org_id, entity, key)
);

CREATE TABLE IF NOT EXISTS tags (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  color         TEXT NOT NULL DEFAULT '#0ea5e9',
  created_at    TEXT NOT NULL,
  UNIQUE (org_id, name)
);

-- ─────────────────────────────────────────────── customers, leads, projects

CREATE TABLE IF NOT EXISTS customers (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  company       TEXT,
  vat_number    TEXT,
  phone         TEXT,
  email         TEXT,
  address       TEXT,
  city          TEXT,
  postal_code   TEXT,
  region        TEXT,
  preferred_contact TEXT DEFAULT 'phone' CHECK (preferred_contact IN ('phone','email','whatsapp','sms')),
  notes         TEXT,
  marketing_consent INTEGER NOT NULL DEFAULT 0,
  marketing_consent_at TEXT,
  marketing_consent_source TEXT,
  owner_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  became_customer_at TEXT,
  lifetime_value REAL NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_customers_org ON customers(org_id);
CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(org_id, phone);
CREATE INDEX IF NOT EXISTS idx_customers_email ON customers(org_id, email);

CREATE TABLE IF NOT EXISTS leads (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  reference     TEXT NOT NULL,
  customer_id   TEXT REFERENCES customers(id) ON DELETE SET NULL,

  -- contact snapshot (a lead can exist before a customer record is promoted)
  first_name    TEXT NOT NULL,
  last_name     TEXT NOT NULL,
  company       TEXT,
  phone         TEXT,
  email         TEXT,
  address       TEXT,
  city          TEXT,
  postal_code   TEXT,
  region        TEXT,
  preferred_contact TEXT DEFAULT 'phone',
  notes         TEXT,

  -- commercial
  source_id     TEXT REFERENCES lead_sources(id) ON DELETE SET NULL,
  campaign      TEXT,
  utm           TEXT NOT NULL DEFAULT '{}',
  owner_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  stage_id      TEXT REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  stage_entered_at TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','won','lost')),
  temperature   TEXT NOT NULL DEFAULT 'cold' CHECK (temperature IN ('hot','warm','cold')),
  score         INTEGER NOT NULL DEFAULT 0,
  score_breakdown TEXT NOT NULL DEFAULT '[]',
  scored_at     TEXT,
  estimated_value REAL NOT NULL DEFAULT 0,
  probability   INTEGER NOT NULL DEFAULT 0,
  expected_close_date TEXT,
  project_types TEXT NOT NULL DEFAULT '[]',    -- JSON ["pv","heat_pump","battery","ev_charger","other"]
  urgency       TEXT DEFAULT 'unknown' CHECK (urgency IN ('immediate','1_3_months','3_6_months','later','unknown')),
  budget_known  INTEGER NOT NULL DEFAULT 0,
  budget_amount REAL,
  -- The customer asked for a price, rather than us having sent one. It is the
  -- single strongest early qualifier, so it is recorded from the moment it is known.
  requested_quote INTEGER NOT NULL DEFAULT 0,
  -- "Do not contact me automatically." Blocks automated sends on every channel;
  -- a person can still send an operational message by hand.
  messaging_opt_out INTEGER NOT NULL DEFAULT 0,

  -- lifecycle
  first_contacted_at TEXT,
  last_activity_at   TEXT,
  next_action_id     TEXT,
  won_at        TEXT,
  lost_at       TEXT,
  lost_reason_id TEXT REFERENCES lost_reasons(id) ON DELETE SET NULL,
  lost_notes    TEXT,
  recovery_date TEXT,
  recovered_at  TEXT,
  automation_paused INTEGER NOT NULL DEFAULT 0,
  consent_marketing INTEGER NOT NULL DEFAULT 0,
  gdpr_basis    TEXT DEFAULT 'legitimate_interest',

  -- technical detail (project-type specific, kept as columns so they are filterable)
  pv_interest           INTEGER NOT NULL DEFAULT 0,
  pv_existing_system    INTEGER NOT NULL DEFAULT 0,
  pv_desired_kwp        REAL,
  pv_annual_kwh         REAL,
  pv_monthly_bill       REAL,
  pv_roof_type          TEXT,      -- tile | flat_concrete | metal | shingle | ground | carport | other
  pv_roof_orientation   TEXT,      -- S | SE | SW | E | W | N | mixed
  pv_roof_area_m2       REAL,
  pv_roof_tilt          TEXT,
  pv_shading            TEXT,      -- none | partial | heavy
  pv_property_type      TEXT,      -- detached | apartment | commercial | industrial | agricultural
  pv_phase              TEXT,      -- single | three
  pv_grid_connection    TEXT,      -- net_metering | net_billing | self_consumption | off_grid | unknown
  pv_meter_number       TEXT,
  pv_install_location   TEXT,      -- roof | ground | carport | facade
  battery_interest      INTEGER NOT NULL DEFAULT 0,
  battery_kwh           REAL,
  ev_charger_interest   INTEGER NOT NULL DEFAULT 0,
  ev_charger_kw         REAL,
  backup_power_interest INTEGER NOT NULL DEFAULT 0,

  hp_interest           INTEGER NOT NULL DEFAULT 0,
  hp_existing_system    TEXT,      -- oil_boiler | gas_boiler | pellet | ac_units | electric | none | other
  hp_current_fuel       TEXT,
  hp_annual_heating_cost REAL,
  hp_property_type      TEXT,
  hp_property_m2        REAL,
  hp_floors             INTEGER,
  hp_emitters           TEXT,      -- radiators | underfloor | fan_coils | mixed | none
  hp_existing_boiler    TEXT,
  hp_dhw_required       INTEGER NOT NULL DEFAULT 0,
  hp_dhw_litres         REAL,
  hp_cooling_required   INTEGER NOT NULL DEFAULT 0,
  hp_insulation         TEXT,      -- poor | average | good | excellent | unknown
  hp_estimated_kw       REAL,
  hp_removal_required   INTEGER NOT NULL DEFAULT 0,

  custom_data   TEXT NOT NULL DEFAULT '{}',
  intake_payload TEXT,
  intake_channel TEXT NOT NULL DEFAULT 'manual', -- manual | web_form | api | webhook | import
  dedupe_key    TEXT,
  duplicate_of  TEXT REFERENCES leads(id) ON DELETE SET NULL,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  deleted_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (org_id, reference)
);
CREATE INDEX IF NOT EXISTS idx_leads_org_status ON leads(org_id, status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads(org_id, owner_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(org_id, stage_id);
CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(org_id, source_id);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(org_id, phone);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(org_id, email);
CREATE INDEX IF NOT EXISTS idx_leads_dedupe ON leads(org_id, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_leads_activity ON leads(org_id, last_activity_at);
CREATE INDEX IF NOT EXISTS idx_leads_temp ON leads(org_id, temperature, status);
-- Drives the score-decay sweep: the open leads with the oldest scores, first.
CREATE INDEX IF NOT EXISTS idx_leads_scored ON leads(status, scored_at);

CREATE TABLE IF NOT EXISTS lead_tags (
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id       TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  tag_id        TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (lead_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_leadtags_tag ON lead_tags(org_id, tag_id);

CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  customer_id   TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  lead_id       TEXT REFERENCES leads(id) ON DELETE SET NULL,
  name          TEXT NOT NULL,
  project_type  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'opportunity'
                CHECK (status IN ('opportunity','won','scheduled','in_progress','commissioned','completed','cancelled')),
  system_size   TEXT,
  contract_value REAL NOT NULL DEFAULT 0,
  installation_status TEXT NOT NULL DEFAULT 'not_started'
                CHECK (installation_status IN ('not_started','scheduled','in_progress','commissioned','handed_over')),
  planned_install_date TEXT,
  actual_install_date  TEXT,
  technician_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','deposit_paid','partially_paid','paid')),
  amount_paid   REAL NOT NULL DEFAULT 0,
  warranty_years INTEGER,
  warranty_expires_at TEXT,
  maintenance_due_at TEXT,
  technical_notes TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org_id, status);
CREATE INDEX IF NOT EXISTS idx_projects_customer ON projects(org_id, customer_id);

-- ─────────────────────────────────────────────── work items

CREATE TABLE IF NOT EXISTS activities (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id       TEXT REFERENCES leads(id) ON DELETE CASCADE,
  customer_id   TEXT REFERENCES customers(id) ON DELETE CASCADE,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  quotation_id  TEXT,
  type          TEXT NOT NULL,   -- created|note|call|email|whatsapp|sms|meeting|status_change|stage_change|quote|task|appointment|survey|document|automation|score|system|assignment
  direction     TEXT DEFAULT 'internal' CHECK (direction IN ('inbound','outbound','internal')),
  title         TEXT NOT NULL,
  body          TEXT,
  meta          TEXT NOT NULL DEFAULT '{}',
  outcome       TEXT,            -- answered|no_answer|voicemail|callback|interested|not_interested
  duration_sec  INTEGER,
  occurred_at   TEXT NOT NULL,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  is_customer_touch INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activities_lead ON activities(org_id, lead_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_activities_org_time ON activities(org_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_activities_user ON activities(org_id, user_id, occurred_at);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id       TEXT REFERENCES leads(id) ON DELETE CASCADE,
  customer_id   TEXT REFERENCES customers(id) ON DELETE CASCADE,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  quotation_id  TEXT,
  appointment_id TEXT,
  survey_id     TEXT,
  title         TEXT NOT NULL,
  description   TEXT,
  type          TEXT NOT NULL DEFAULT 'follow_up', -- follow_up|call|email|whatsapp|meeting|quote|survey|admin|post_sale
  assignee_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  due_at        TEXT,
  priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('urgent','high','normal','low')),
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  completed_at  TEXT,
  completed_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  outcome_note  TEXT,
  is_next_action INTEGER NOT NULL DEFAULT 1,
  recurrence    TEXT,      -- null | daily | weekly | monthly
  source        TEXT NOT NULL DEFAULT 'manual', -- manual | automation | sequence | system
  automation_run_id TEXT,
  dedupe_key    TEXT,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(org_id, assignee_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_lead ON tasks(org_id, lead_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(org_id, status, due_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_dedupe ON tasks(org_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS appointments (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id       TEXT REFERENCES leads(id) ON DELETE CASCADE,
  customer_id   TEXT REFERENCES customers(id) ON DELETE CASCADE,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  type          TEXT NOT NULL DEFAULT 'site_survey' CHECK (type IN ('site_survey','sales_meeting','call','installation','service','other')),
  title         TEXT NOT NULL,
  description   TEXT,
  starts_at     TEXT NOT NULL,
  ends_at       TEXT NOT NULL,
  location      TEXT,
  assignee_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  technician_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled','no_show')),
  outcome_note  TEXT,
  -- Set only when a provider actually accepted the confirmation message.
  confirmation_sent_at TEXT,
  -- When the reminder was ISSUED (the sequence started), not when it arrived.
  -- It is the guard that stops one appointment being reminded twice; whether the
  -- message went out is recorded on the message row and the sequence log.
  reminder_sent_at     TEXT,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_appt_org_time ON appointments(org_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appt_status_time ON appointments(status, starts_at);
CREATE INDEX IF NOT EXISTS idx_appt_assignee ON appointments(org_id, assignee_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appt_tech ON appointments(org_id, technician_id, starts_at);

-- ─────────────────────────────────────────────── quotations

CREATE TABLE IF NOT EXISTS quotations (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  -- The survey this quotation was built from, when it was. Lets the dashboard
  -- find surveys that were completed but never quoted.
  survey_id     TEXT,
  number        TEXT NOT NULL,
  lead_id       TEXT REFERENCES leads(id) ON DELETE CASCADE,
  customer_id   TEXT REFERENCES customers(id) ON DELETE SET NULL,
  project_id    TEXT REFERENCES projects(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'draft'
                CHECK (status IN ('draft','sent','viewed','awaiting_response','accepted','rejected','expired','cancelled')),
  currency      TEXT NOT NULL DEFAULT 'EUR',
  subtotal      REAL NOT NULL DEFAULT 0,
  discount_type TEXT NOT NULL DEFAULT 'amount' CHECK (discount_type IN ('amount','percent')),
  discount_value REAL NOT NULL DEFAULT 0,
  discount_amount REAL NOT NULL DEFAULT 0,
  vat_rate      REAL NOT NULL DEFAULT 24,
  vat_amount    REAL NOT NULL DEFAULT 0,
  total         REAL NOT NULL DEFAULT 0,
  optional_total REAL NOT NULL DEFAULT 0,
  valid_until   TEXT,
  terms         TEXT,
  notes         TEXT,
  owner_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  sent_at       TEXT,
  sent_via      TEXT,
  first_viewed_at TEXT,
  view_count    INTEGER NOT NULL DEFAULT 0,
  responded_at  TEXT,
  accepted_at   TEXT,
  rejected_at   TEXT,
  rejection_reason TEXT,
  public_token  TEXT UNIQUE,
  pdf_path      TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (org_id, number)
);
CREATE INDEX IF NOT EXISTS idx_quotes_org_status ON quotations(org_id, status);
CREATE INDEX IF NOT EXISTS idx_quotes_lead ON quotations(org_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_quotes_owner ON quotations(org_id, owner_id, status);

CREATE TABLE IF NOT EXISTS quotation_items (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  quotation_id  TEXT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  category      TEXT NOT NULL DEFAULT 'equipment', -- equipment|installation|electrical|civil|service|other
  name          TEXT NOT NULL,
  description   TEXT,
  quantity      REAL NOT NULL DEFAULT 1,
  unit          TEXT NOT NULL DEFAULT 'pcs',
  unit_price    REAL NOT NULL DEFAULT 0,
  discount_pct  REAL NOT NULL DEFAULT 0,
  line_total    REAL NOT NULL DEFAULT 0,
  is_optional   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_qitems_quote ON quotation_items(quotation_id, position);

CREATE TABLE IF NOT EXISTS product_templates (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_type  TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'equipment',
  name          TEXT NOT NULL,
  description   TEXT,
  unit          TEXT NOT NULL DEFAULT 'pcs',
  unit_price    REAL NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_products_org ON product_templates(org_id, project_type);

-- ─────────────────────────────────────────────── site surveys & files

CREATE TABLE IF NOT EXISTS site_surveys (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id       TEXT REFERENCES leads(id) ON DELETE CASCADE,
  customer_id   TEXT REFERENCES customers(id) ON DELETE CASCADE,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  appointment_id TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  technician_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  project_type  TEXT NOT NULL DEFAULT 'pv',
  status        TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','in_progress','completed','cancelled')),
  scheduled_at  TEXT,
  completed_at  TEXT,
  address       TEXT,
  findings      TEXT NOT NULL DEFAULT '{}',   -- JSON structured survey answers
  technical_notes TEXT,
  customer_preferences TEXT,
  feasible      INTEGER,
  recommended_system TEXT,
  estimated_cost REAL,
  blockers      TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_surveys_org ON site_surveys(org_id, status);
CREATE INDEX IF NOT EXISTS idx_surveys_tech ON site_surveys(org_id, technician_id, status);

CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id       TEXT REFERENCES leads(id) ON DELETE CASCADE,
  customer_id   TEXT REFERENCES customers(id) ON DELETE CASCADE,
  project_id    TEXT REFERENCES projects(id) ON DELETE CASCADE,
  survey_id     TEXT REFERENCES site_surveys(id) ON DELETE CASCADE,
  quotation_id  TEXT REFERENCES quotations(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL DEFAULT 'file',  -- file|photo|quote_pdf|contract|permit
  label         TEXT,
  filename      TEXT NOT NULL,
  stored_name   TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  uploaded_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_docs_lead ON documents(org_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_docs_survey ON documents(org_id, survey_id);

-- ─────────────────────────────────────────────── communication

CREATE TABLE IF NOT EXISTS integrations (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,   -- smtp|imap|whatsapp_cloud|meta_lead_ads|google_ads|telephony|anthropic|zapier
  status        TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected','connected','error')),
  config        TEXT NOT NULL DEFAULT '{}',   -- non-secret config, safe to return to the client
  secrets       TEXT NOT NULL DEFAULT '{}',   -- never leaves the server
  last_checked_at TEXT,
  last_error    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (org_id, provider)
);

CREATE TABLE IF NOT EXISTS messages (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  lead_id       TEXT REFERENCES leads(id) ON DELETE CASCADE,
  customer_id   TEXT REFERENCES customers(id) ON DELETE CASCADE,
  quotation_id  TEXT REFERENCES quotations(id) ON DELETE SET NULL,
  channel       TEXT NOT NULL CHECK (channel IN ('email','whatsapp','sms','phone')),
  direction     TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  to_address    TEXT,
  from_address  TEXT,
  subject       TEXT,
  body          TEXT NOT NULL,
  purpose       TEXT NOT NULL DEFAULT 'operational' CHECK (purpose IN ('operational','marketing')),
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('draft','queued','sent','delivered','read','failed','received','blocked')),
  provider      TEXT,
  provider_message_id TEXT,
  error         TEXT,
  sent_at       TEXT,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  automation_run_id TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_lead ON messages(org_id, lead_id, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(org_id, status);

CREATE TABLE IF NOT EXISTS message_templates (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  name          TEXT NOT NULL,
  channel       TEXT NOT NULL DEFAULT 'email',
  purpose       TEXT NOT NULL DEFAULT 'operational' CHECK (purpose IN ('operational','marketing')),
  subject       TEXT,
  body          TEXT NOT NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (org_id, key)
);

-- ─────────────────────────────────────────────── automation

CREATE TABLE IF NOT EXISTS automation_rules (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key           TEXT,
  name          TEXT NOT NULL,
  description   TEXT,
  trigger_type  TEXT NOT NULL,   -- lead_created|stage_changed|temperature_changed|quote_sent|quote_status_changed
                                 -- |lead_won|lead_lost|task_overdue|lead_idle|no_next_action|appointment_scheduled
  trigger_config TEXT NOT NULL DEFAULT '{}',
  conditions    TEXT NOT NULL DEFAULT '[]',   -- JSON [{field,op,value}]
  steps         TEXT NOT NULL DEFAULT '[]',   -- JSON [{delay_minutes, actions:[{type, ...}], stop_if:[...] }]
  stop_on       TEXT NOT NULL DEFAULT '[]',   -- JSON ["customer_replied","appointment_booked","won","lost","paused"]
  is_active     INTEGER NOT NULL DEFAULT 1,
  is_system     INTEGER NOT NULL DEFAULT 0,
  run_count     INTEGER NOT NULL DEFAULT 0,
  last_run_at   TEXT,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rules_org ON automation_rules(org_id, trigger_type, is_active);

CREATE TABLE IF NOT EXISTS automation_runs (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  rule_id       TEXT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  lead_id       TEXT REFERENCES leads(id) ON DELETE CASCADE,
  quotation_id  TEXT REFERENCES quotations(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed','stopped','failed')),
  step_index    INTEGER NOT NULL DEFAULT 0,
  next_run_at   TEXT,
  context       TEXT NOT NULL DEFAULT '{}',
  log           TEXT NOT NULL DEFAULT '[]',
  stopped_reason TEXT,
  error         TEXT,
  started_at    TEXT NOT NULL,
  completed_at  TEXT,
  appointment_id TEXT REFERENCES appointments(id) ON DELETE CASCADE,
  -- SQLite treats NULLs as distinct in a UNIQUE constraint, so (rule, lead, NULL)
  -- would not actually deduplicate a lead-only rule. This flattened key does:
  -- one run per rule per target, with "-" standing in for the empty parts.
  run_key       TEXT,
  UNIQUE (rule_id, lead_id, quotation_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_key ON automation_runs(run_key) WHERE run_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_runs_due ON automation_runs(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_runs_lead ON automation_runs(org_id, lead_id);

-- ─────────────────────────────────────────────── notifications, audit, saved views

CREATE TABLE IF NOT EXISTS notifications (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,  -- lead_assigned|hot_lead|task_overdue|quote_stale|appointment_soon|lead_idle|deal_won|mention
  severity      TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical','success')),
  title         TEXT NOT NULL,
  body          TEXT,
  link          TEXT,
  lead_id       TEXT REFERENCES leads(id) ON DELETE CASCADE,
  dedupe_key    TEXT,
  read_at       TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(org_id, user_id, read_at, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notif_dedupe ON notifications(org_id, user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS audit_logs (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_label   TEXT NOT NULL DEFAULT 'system',
  action        TEXT NOT NULL,   -- lead.created, lead.assigned, quote.sent, user.added, automation.updated ...
  entity_type   TEXT NOT NULL,
  entity_id     TEXT,
  entity_label  TEXT,
  changes       TEXT NOT NULL DEFAULT '{}',
  ip            TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_org ON audit_logs(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(org_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS saved_views (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  entity        TEXT NOT NULL DEFAULT 'lead',
  filters       TEXT NOT NULL DEFAULT '{}',
  is_shared     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL
);

-- ─────────────────────────────────────────────── billing

CREATE TABLE IF NOT EXISTS subscriptions (
  id            TEXT PRIMARY KEY,
  org_id        TEXT NOT NULL UNIQUE REFERENCES organizations(id) ON DELETE CASCADE,
  plan          TEXT NOT NULL DEFAULT 'starter' CHECK (plan IN ('trial','starter','growth','pro')),
  status        TEXT NOT NULL DEFAULT 'trialing' CHECK (status IN ('trialing','active','past_due','cancelled')),
  price_eur     REAL NOT NULL DEFAULT 0,
  seats         INTEGER NOT NULL DEFAULT 2,
  lead_limit    INTEGER NOT NULL DEFAULT 250,
  features      TEXT NOT NULL DEFAULT '[]',
  trial_ends_at TEXT,
  period_start  TEXT NOT NULL,
  period_end    TEXT NOT NULL,
  cancelled_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_counters (
  org_id        TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  period        TEXT NOT NULL,          -- YYYY-MM
  metric        TEXT NOT NULL,          -- leads_created | ai_calls | emails_sent
  value         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, period, metric)
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id            TEXT PRIMARY KEY,       -- org_id + ':' + key
  org_id        TEXT NOT NULL,
  key           TEXT NOT NULL,
  endpoint      TEXT NOT NULL,
  response      TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_idem_created ON idempotency_keys(created_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket        TEXT PRIMARY KEY,
  count         INTEGER NOT NULL,
  window_start  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);
