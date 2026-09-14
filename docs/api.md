# API reference

Base URL: `http://localhost:4000/api` in development, your own domain in
production. Everything speaks JSON; send `Content-Type: application/json`.

There are three separate surfaces:

| Surface | Prefix | Who calls it | Auth |
|---|---|---|---|
| Public | `/api/public/*` | your website, ad platforms, your customers | a form token, an API key, or a quotation token |
| Sign-in | `/api/auth/*` | the browser | email + password, then a refresh cookie |
| Application | everything else under `/api` | the signed-in app, or your own scripts | `Authorization: Bearer <access token>` |

## Errors

Every failure has the same shape, and the `message` is written to be shown to a
person as-is.

```json
{ "error": { "code": "limit_reached", "message": "You have reached the 250 lead limit for the Starter plan this month. Upgrade to keep capturing leads.", "details": { "limit": 250, "used": 250 } } }
```

| Code | HTTP | Meaning |
|---|---|---|
| `validation_error` | 400 | body failed validation; `error.fields[]` lists `path` and `message` |
| `bad_request` | 400 | the request made sense but cannot be applied |
| `unauthorized` | 401 | missing, expired or invalid token |
| `forbidden` | 403 | your role does not allow this |
| `limit_reached` | 402 | a plan limit or a feature gate; `details.upgrade_to` names the plan that includes it |
| `not_found` | 404 | it does not exist — **or it belongs to another organisation** |
| `conflict` | 409 | duplicate lead, quotation already answered, and similar |
| `not_configured` | 409 | the integration this action needs has not been connected |
| `rate_limited` | 429 | slow down |

Cross-tenant reads deliberately return **404, not 403**, so no record's
existence leaks across organisations.

---

## Authentication

```http
POST /api/auth/signup      { company_name, name, email, password, phone?, services? }
POST /api/auth/login       { email, password }
POST /api/auth/refresh     (uses the httpOnly vf_refresh cookie)
POST /api/auth/logout
POST /api/auth/forgot-password  { email }
POST /api/auth/reset-password   { token, password }
POST /api/auth/accept-invite    { token, name, password }
GET  /api/auth/sessions         list this user's active sessions
POST /api/auth/change-password  { current_password, password }
```

`login` and `signup` return:

```json
{ "accessToken": "<jwt>", "user": { "id": "...", "name": "...", "role": "owner" } }
```

The access token lasts 30 minutes. The refresh token is set as an httpOnly,
SameSite cookie (`vf_refresh`, 30 days) and is stored server-side only as a
SHA-256 hash, so a stolen database row cannot be replayed as a session. Send the
access token on every application call:

```http
Authorization: Bearer <accessToken>
```

`GET /api/me` is the boot call: it returns the user, the organisation, the
**permission matrix for the role**, the subscription with live usage, whether AI
is available, and the unread notification count. The client hides what the role
cannot do — and every route re-checks the same permission server-side, so hiding
a button is never the only defence.

Rate limits are fixed-window and stored in the database, so they survive a
restart: 20 login attempts per 15 minutes per IP+email, 10 signups or
password-reset requests per hour, 600 authenticated calls per minute per user,
120 intake calls per minute per API key.

---

## Public surface

### Lead intake (server to server)

The endpoint for landing pages, Make.com, Zapier, Google Lead Form extensions
and Meta Lead Ads. Create the key in **Settings → Integrations → API key**; it is
shown once and stored only as a hash.

```http
POST /api/public/intake
X-API-Key: vf_live_...
Idempotency-Key: 4f1c...           # optional but recommended
Content-Type: application/json

{
  "first_name": "Nikos",
  "last_name": "Antoniou",
  "phone": "+30 694 123 4567",
  "email": "nikos@example.gr",
  "city": "Larissa",
  "source": "meta_ads",
  "campaign": "spring-pv",
  "project_types": ["pv", "battery"],
  "estimated_value": 9800,
  "notes": "Wants a quote before the end of the month.",
  "consent_marketing": true,
  "requested_quote": true,
  "fields": { "pv_monthly_bill": 210, "pv_roof_type": "tile" },
  "utm": { "utm_source": "meta", "utm_campaign": "spring-pv" }
}
```

```json
{
  "ok": true,
  "lead": { "id": "ld_...", "reference": "L-2026-0147", "owner_id": "us_...", "score": 78, "temperature": "warm" },
  "duplicates": [{ "id": "ld_...", "type": "lead", "matched_on": "phone" }]
}
```

Notes that matter in practice:

- **`Idempotency-Key` is honoured.** A retried webhook replays the original
  response instead of creating a second lead. Keys are scoped per organisation.
- **Duplicates are reported, not dropped.** A returning customer still reaches
  the sales team; the new lead is linked to what it matched. Phone numbers are
  normalised first, so `+30 694…`, `0030694…` and `694…` all match.
- `source` must be one of your configured lead sources (Settings → Sources);
  anything else is recorded as `other` rather than rejected, so a typo in an ad
  platform never loses a lead.
- `fields` accepts any of the PV and heat-pump technical columns; unknown keys
  are ignored.
- `requested_quote` says the person asked for a price rather than browsing. It is
  worth 25 points on its own — set it when your ad or landing page asked them to
  request a quotation. The embedded website form sets it for you.
- Creating a lead also assigns an owner by your rules, scores it, creates the
  first follow-up task and notifies the owner. That happens on every intake
  path, not just this one.

### Embedded form

```http
GET  /api/public/form/:token     the company branding and question tree
POST /api/public/form/:token     a submission
GET  /embed.js                   the widget script
```

See [`embedding.md`](embedding.md).

### Customer quotation link

```http
GET  /api/public/quote/:token        the quotation as the customer sees it
GET  /api/public/quote/:token/pdf    the generated A4 PDF
POST /api/public/quote/:token/respond  { decision: "accepted" | "rejected", note? }
```

Opening the link records the first view on the lead timeline and moves the
quotation to `viewed`. A quotation can only be answered once, and never after
`valid_until`.

---

## Application surface

All of these need `Authorization: Bearer`. List endpoints paginate with
`?page=` and `?per_page=` and return `{ items, total, page, per_page }`.

### Leads

```http
GET    /api/leads                 ?q=&stage=&owner=&temperature=&source=&tag=&status=&sort=
GET    /api/leads/duplicates      ?phone=&email=   live duplicate check while typing
POST   /api/leads
GET    /api/leads/:id
GET    /api/leads/:id/activities
PATCH  /api/leads/:id
DELETE /api/leads/:id
POST   /api/leads/:id/stage       { stage_id, note? }
POST   /api/leads/:id/assign      { user_id }
POST   /api/leads/:id/won         { value, note? }
POST   /api/leads/:id/lost        { lost_reason_id, note?, recovery_date? }
POST   /api/leads/:id/reopen
POST   /api/leads/:id/rescore
POST   /api/leads/:id/automation  { paused: true | false }
POST   /api/leads/:id/activities  { type, subject?, body?, outcome?, duration_minutes? }
PUT    /api/leads/:id/tags        { tags: ["referral", "urgent"] }
POST   /api/leads/:id/customer    promote to a customer record
```

A lead always carries `owner_id`, `stage`, `temperature`, `score`,
`next_action`, `next_action_at`, `source`, `estimated_value` and its activity
history. `next_action` is derived from the earliest open task, so it cannot
drift out of sync with the work; a lead with no open task is what the dashboard
flags under **Needs attention**.

`GET /api/leads/:id` includes `score_breakdown` — every factor that fired, the
points it contributed and why — and `missing_information`, the fields still
needed before this project type can be quoted accurately.

### Pipeline, tasks, calendar

```http
GET  /api/pipeline                the board, grouped by stage, with stage totals
POST /api/pipeline/move           { lead_id, stage_id, position? }
GET  /api/tasks                   ?bucket=today|overdue|week|open&owner=&status=
POST /api/tasks                   { lead_id?, title, due_at, type?, assigned_to? }
PATCH /api/tasks/:id
POST /api/tasks/:id/complete      { outcome? }
POST /api/tasks/:id/reschedule    { due_at }
DELETE /api/tasks/:id
GET  /api/appointments            ?from=&to=
POST /api/appointments            { lead_id, type, starts_at, ends_at, location? }
GET  /api/calendar                ?from=&to=   tasks and appointments in one feed
```

### Quotations

```http
GET   /api/quotations             ?status=&owner=&lead=
POST  /api/quotations/preview-totals   price a basket without saving it
POST  /api/quotations             { lead_id | customer_id, title, items[], discount_type?, discount_value?, vat_rate?, valid_until?, terms?, notes? }
GET   /api/quotations/:id
PATCH /api/quotations/:id
GET   /api/quotations/:id/pdf     generates and streams a real PDF
POST  /api/quotations/:id/send    { channel: "email" | "whatsapp" | "manual", message? }
POST  /api/quotations/:id/status  { status, rejection_reason? }
POST  /api/quotations/:id/duplicate
DELETE /api/quotations/:id
GET   /api/quotations/meta/products    your price list
```

Each item is `{ product_template_id?, name, description?, quantity, unit, unit_price, discount_pct?, is_optional? }`.
Optional lines are totalled separately and never included in the amount the
customer owes. `POST /:id/send` with `channel: "email"` **fails with
`not_configured` when SMTP has not been connected** — it does not claim to have
sent anything. `channel: "manual"` is the honest escape hatch: it records that
you sent it yourself and starts the follow-up sequence.

### Surveys, documents, customers, projects

```http
GET/POST/PATCH /api/surveys       site surveys with per-project-type checklists
GET/POST/DELETE /api/documents    uploads (type and size checked, random storage names)
GET/POST/PATCH /api/customers
GET/POST/PATCH /api/projects      the post-sale installation record
```

### Analytics

Every number is computed from the database at request time; nothing is
hard-coded or sampled.

```http
GET /api/analytics/sales      ?from=&to=   funnel, conversion, average deal, cycle, response time
GET /api/analytics/sources    per-source leads → qualified → quoted → won → revenue
GET /api/analytics/team       per-salesperson performance, response time, overdue follow-ups
GET /api/analytics/forecast   weighted pipeline by stage probability
GET /api/analytics/recovery   lost leads worth going back to
```

### Automations

```http
GET    /api/automations
GET    /api/automations/:id
POST   /api/automations       { name, trigger_type, trigger_config?, conditions?, steps[], stop_on[] }
PATCH  /api/automations/:id
DELETE /api/automations/:id
GET    /api/automations/:id/runs   what actually happened, per lead
```

See [`automation.md`](automation.md) for the rule format and the eight rules
that ship switched on.

### Settings

```http
GET/PATCH /api/settings/company
CRUD      /api/settings/stages       (+ POST /stages/reorder)
CRUD      /api/settings/sources, /lost-reasons, /custom-fields, /assignment
GET/PATCH /api/settings/scoring      the scoring factors and their weights
GET/PATCH /api/settings/templates    message templates
GET/POST/PATCH /api/settings/users   invite and manage the team (seat-limited)
PATCH     /api/settings/profile
GET       /api/settings/integrations status only — secrets are never returned
PUT       /api/settings/integrations/:provider   connect or disconnect
POST      /api/settings/api-key      rotate; the new key is shown exactly once
POST      /api/settings/form-token   rotate the public form token
GET/POST  /api/settings/subscription
```

Integration secrets are write-only over the API. `GET /integrations` returns
`connected`, `verified_at` and the last error, never the credential. SMTP is
verified against your server before it is marked connected.

### Data, GDPR and audit

```http
GET  /api/data/search                 across leads, customers, quotations
GET/POST/DELETE /api/data/views       saved filters
GET  /api/data/export/:entity         CSV
GET  /api/data/import/fields          the importable columns
POST /api/data/import/leads           dry run first, then commit
GET  /api/data/audit                  ?entity=&user=&from=&to=
GET  /api/data/gdpr/subject/:type/:id everything held about one person
POST /api/data/gdpr/erase             { type, id, confirm: true }
POST /api/data/demo                   load or clear sample data
```

Erasure anonymises the personal data and keeps the commercial totals your
accountant needs. Both the export and the erasure are themselves audited.

### Messages and notifications

```http
GET  /api/messages/channels    which channels are actually connected
GET  /api/messages             ?lead=
POST /api/messages/send        { lead_id, channel, template_key? | body, subject? }
POST /api/messages/call        { lead_id }  click-to-call, logs the attempt
POST /api/messages/inbound     provider webhook for replies
GET  /api/notifications        ?unread=
POST /api/notifications/read   { ids? }     omit ids to mark all read
GET  /api/notifications/preferences
```

A send to a channel that is not connected returns `not_configured`, writes the
message with status `blocked` and the reason, and the lead timeline shows it as
**NOT sent**. Marketing sends are refused without a recorded lawful basis, and
the refusal is logged.
