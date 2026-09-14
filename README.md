# VoltaFlow

**Lead and sales software for solar PV and heat-pump installation companies.**

> Turn more solar & heat-pump leads into customers.
> Capture every inquiry, automate follow-ups, manage quotations, and give your
> sales team a clear view of every opportunity — all in one place.

VoltaFlow is not a generic CRM with solar wording bolted on. The fields, pipeline
stages, survey checklists, price lists, scoring factors and follow-up sequences are
the ones an installer actually uses.

The single problem it solves:

> *"We receive leads, but some are forgotten, followed up too late, poorly
> qualified, or lost after sending a quotation."*

So every lead always carries an **owner**, a **status**, a **temperature**, a
**next action with a date**, a **source**, a **potential value** and a **complete
interaction history** — and anything missing a next action is flagged on the
dashboard until someone deals with it.

The dashboard opens on **what needs you now**: one ranked list of overdue
follow-ups, hot leads going quiet, surveys waiting for a quotation, quotations
the customer opened but never answered, visits nobody closed off, and sold jobs
with no installation date — each with the customer's name, the reason, the money
at stake, and the button that does the thing.

---

## Running it

```bash
npm install          # installs the server and client workspaces
npm run db:migrate   # creates the SQLite schema
npm run db:seed      # a demo company with 12 realistic leads (optional)
npm run dev          # API on :4000, client on :5173
```

Open <http://localhost:5173>. The seed prints sign-in details for five users:

| Role | Email | What they see |
|---|---|---|
| Owner | `owner@heliosenergy.gr` | everything |
| Sales manager | `katerina@heliosenergy.gr` | all leads, the team, analytics |
| Salesperson | `alexis@heliosenergy.gr` | only their own book |
| Salesperson | `marina@heliosenergy.gr` | only their own book |
| Technician | `stavros@heliosenergy.gr` | site surveys and installation jobs |

Password for all of them: `VoltaFlow2026!`

For production:

```bash
npm run build        # builds the client, compiles the server
npm start            # serves the API and the built client from :4000
```

Copy `.env.example` to `.env` and set at least `VF_JWT_SECRET` before deploying.

---

## What is in it

### Capture
- **Website form** — a three-step embeddable form that asks different questions
  depending on whether the customer picks photovoltaic, heat pump, battery or
  EV charger. Paste one `<script>` tag on any website.
- **Intake API** — `POST /api/public/intake` with an organisation API key, for
  landing pages, Make.com, Zapier, Google and Meta lead forms. Idempotency keys
  mean a retried webhook never creates a second lead.
- **CSV import** — column mapping, per-row validation, duplicate detection
  against existing records, and a dry run you must review before anything is written.
- **Manual entry** — with live duplicate checking while you type the phone number.

Every arriving lead is de-duplicated (phone numbers normalise across `+30`, `0030`
and bare formats), assigned by your rules, scored, given a first follow-up task,
and its owner is notified.

### Qualify
- **Transparent scoring** — 0–100 from configurable factors (requested a
  quotation, project value, consumption, heating cost, urgency, budget, engagement,
  completeness, staleness…). The lead page shows exactly which factors fired and
  for how many points. Nothing is a black box.
- **Missing information** — the lead tells you what is still needed before it can
  be quoted accurately, per project type.
- **Technical fields** — full PV set (kWp, annual kWh, bill, roof type,
  orientation, area, shading, phase, grid connection, battery, EV charger, backup)
  and heat-pump set (existing system, fuel, annual cost, m², floors, emitters,
  insulation, DHW, cooling, estimated kW, removal).

### Talk to the customer
Every lead has a **communication panel**: phone, email, preferred channel, when
they were last contacted, which channels actually work right now, and the message
history — including what was **not** sent and why. WhatsApp, email and
click-to-call are one button each, and the composer opens on a real template
already rendered for that customer, which you edit before sending.

Installer-specific templates ship for first contact, survey confirmation and
reminder, quotation sent and follow-up, appointment confirmation, reminder,
change and cancellation, installation confirmation and the after-installation
check-in.

A contact can also say "do not contact me automatically": that blocks every
automated send and stops the running sequences, while a person can still write to
them by hand about their own enquiry.

### Follow up
Nine automation rules ship switched on:

1. **New lead** → assign, notify, first follow-up in 30 minutes, then day 1, 3, 7 and 14.
2. **No contact** → alert the owner when a lead goes quiet.
3. **Hot lead** → notify the owner and the sales manager immediately.
4. **Quote sent** → day 2 / 5 / 10 / 20 follow-up sequence.
5. **Overdue** → notify the assignee the moment a follow-up passes its due date.
6. **Lost** → collect the reason and schedule the recovery task.
7. **Won** → record the revenue, stop the sales sequences, create the customer and
   open the installation handover.
8. **No next action** → flag the lead prominently.
9. **Appointment reminder** → one message to the customer the evening before a visit.

Three further sequences — day 1/3/7/14 messages on a new lead, day 2/5/10/20 on a
quotation, and a check-in after the installation — ship **switched off**, because
they message real customers. Turn them on once a channel is connected and you are
happy with the wording.

Sequences stop automatically when the customer replies, an appointment is booked,
the deal is won or lost, the contact opts out, or a salesperson pauses automation
on that lead. Each lead shows its running sequences with the next scheduled step,
everything already done, anything that failed, and a Stop button. A visual builder
lets you add your own rules without programming.

### Quote
- **Straight from the survey.** A completed site survey offers **Create
  quotation**, and the builder opens pre-filled: quantities from what the
  technician measured, prices from your own price list. Anything the survey did
  not establish is flagged **Needs review** with the reason rather than guessed,
  and you edit every line before the quotation is created. Nothing is sent to the
  customer without you.
- Builder with your own price list (PV, battery, heat pump, EV charger), line
  discounts, optional extras priced separately, VAT and validity.
- **Real PDF generation** — a proper A4 proposal with your logo and terms.
- A **customer link** where the customer reads the quotation, downloads the PDF
  and accepts or declines. Viewing and answering both land on the lead timeline.
- Statuses: draft → sent → viewed → awaiting response → accepted / rejected / expired.

### Deliver
- **Appointments** for site surveys, sales meetings, calls, installations and
  service visits. Double bookings are refused with a note of what is already in
  the diary (and can be overridden deliberately); a confirmation to the customer
  is one checkbox, and the result is reported honestly. Moving one moves its
  survey and its task and re-arms the reminder; cancelling closes both. A visit
  that quietly passed is surfaced as "did this happen?" rather than left open.
- **Site surveys** with per-project-type checklists (roof, electrical, system
  proposal, access for PV; existing system, building, installation for heat pumps),
  photo upload straight from a phone camera, feasibility and a recommended system
  that flows back onto the lead.
- **Installations** — the post-sale handover: installation status, technician,
  planned date, payment status, warranty and maintenance date.

### Understand
- Funnel, conversion rate, average deal, sales cycle and response time.
- **Source attribution** — leads → qualified → quotes → won → revenue for every
  channel, so you can see which marketing actually pays.
- Salesperson performance, including response time and overdue follow-ups.
- Weighted pipeline and revenue forecast, with per-stage probabilities you control.
- Lost-lead recovery dashboard.

---

## Architecture

```
server/                 Node 22 + Express + SQLite (node:sqlite, no native deps)
  src/db/schema.sql     35 tables, every tenant row carries org_id
  src/lib/              domain: leads, scoring, automation, quotations, pdf,
                        messaging, billing, auth, permissions, audit
  src/routes/           the HTTP surface, one router per area
  src/jobs/scheduler.ts the tick that drives automation and overdue alerts
  test/                 67 domain tests (node:test)
web/                    React 19 + Vite + TanStack Query
  src/pages/            one file per screen
  src/components/       shared UI, lead form, quotation builder
  src/styles/app.css    the whole design system, light and dark
```

**Tenancy.** Every tenant table has `org_id`, every query is scoped by it, and a
test asserts that no tenant table is missing the column. Cross-tenant reads return
404, not 403, so nothing leaks by existence.

**Security.** bcrypt passwords, short-lived access tokens with httpOnly refresh
cookies, server-side role checks on every route, Zod validation on every body,
fixed-window rate limiting backed by the database, upload type and size
restrictions with randomised storage names, and an audit log of everything that
matters. Integration secrets are stored server-side and never serialised to the
client.

**Performance.** Indexed queries, pagination everywhere, debounced search, lazy-loaded
analytics bundles, and a single dashboard round trip. The scheduler's sweeps are
bounded and indexed, so the dashboard stays responsive with tens of thousands of leads.

---

## Integrations, and what "not connected" means

VoltaFlow never claims something happened when it did not.

| Channel | State | Behaviour |
|---|---|---|
| Email (SMTP) | verified against your server before it is saved | sends and attaches PDFs when connected; refuses with a clear message when not |
| WhatsApp Business Cloud | full request implemented | refuses until a phone number id and token are saved |
| Telephony | optional | click-to-call always works; a provider adds automatic call logging |
| AI (Claude) | optional | summaries, next actions, draft replies; refuses without a key |
| Meta Lead Ads / Google Ads | intake endpoint ready | post leads with your API key today |

A message that could not be sent is recorded with status `blocked` or `failed`,
the reason is stored, and the lead timeline says **"NOT sent"**. Automation that
cannot send writes the same into its run log. You always know what actually went out.

---

## GDPR

Built for European businesses:

- Operational and marketing messages are separated in the data model; marketing is
  blocked without recorded consent, and the block is logged.
- Consent is captured on the website form and shown on every lead and customer.
- Subject access export returns everything held about a person.
- Erasure anonymises the personal data and keeps the commercial totals your
  accountant needs, and requires explicit confirmation.
- Configurable retention for lost leads, a privacy policy link on the public form,
  and a full audit trail.

---

## Plans

| | Starter €79 | Growth €149 | Pro €249 |
|---|---|---|---|
| Users | 2 | 5 | 15 |
| Leads / month | 250 | 1,000 | 25,000 |
| Pipeline, scoring, quotations | ✓ | ✓ | ✓ |
| Custom automation | | ✓ | ✓ |
| Analytics and attribution | | ✓ | ✓ |
| Site surveys, integrations | | ✓ | ✓ |
| AI assistance, open API | | | ✓ |

Limits live in `server/src/lib/defaults.ts` and are enforced server-side, so the
pricing model can change without touching the rest of the product. A 14-day trial
starts with the full Growth feature set plus AI.

---

## Tests

```bash
npm test          # 67 domain tests: scoring, quotations, automation, tenancy, limits
npm run typecheck # server and client
npm run build     # production build of both
```

The suite covers duplicate detection across phone formats, score explanation,
quotation arithmetic including optional lines and over-discounting, real PDF bytes,
the full automation lifecycle (new lead → contacted → quoted → won / lost →
recovery), next-action tracking, pipeline transitions, tenant isolation,
subscription limits and marketing consent.

See [`docs/`](docs/) for the API reference and the embed guide.
