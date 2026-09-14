# Running it

## Environment

Copy `.env.example` to `.env`. Every value has a working default in development;
in production set at least `VF_JWT_SECRET` and the URLs.

| Variable | Default | What it does |
|---|---|---|
| `NODE_ENV` | `development` | production hides internal error detail and hardens cookies |
| `PORT` | `4000` | the API, and the built client in production |
| `VF_JWT_SECRET` | generated into `data/.secret` | signs access tokens. `openssl rand -hex 48`. **Changing it signs everyone out.** |
| `VF_DATA_DIR` | `./server/data` | SQLite database, uploads, generated PDFs |
| `VF_APP_URL` / `VF_PUBLIC_URL` | `http://localhost:5173` | used in embed snippets, customer quotation links and emails |
| `VF_CORS_ORIGINS` | localhost | comma-separated allow-list |
| `ANTHROPIC_API_KEY` | — | optional fallback AI key for a single-tenant install; each organisation can supply its own in Settings instead |
| `VF_AI_MODEL` | `claude-opus-5` | the model used for the optional AI features |
| `VF_TICK_MS` | `60000` | how often the scheduler runs |

Secrets are read on the server only. Nothing in `web/` reads an API key, and the
integrations endpoint never returns a stored credential — only whether it is
connected, when it was last verified, and the last error.

## The database

SQLite, through Node's built-in `node:sqlite`. No native modules, no build step,
no separate server to run — which is why a first install is `npm install` and
nothing else. WAL mode is on, so reads do not block the scheduler's writes.

```bash
npm run db:migrate   # apply the schema (idempotent — safe to re-run)
npm run db:seed      # a demo company with realistic leads
npm run db:reset     # drop everything and start again (development only)
```

**Backups** are a file copy. With WAL on, copy all three:

```bash
sqlite3 server/data/voltaflow.db ".backup '/backups/voltaflow-$(date +%F).db'"
```

Uploads and generated PDFs live next to it under `VF_DATA_DIR`; back up the whole
directory to have everything.

## The scheduler

One tick, every `VF_TICK_MS`, does all the time-based work. Each sweep is bounded
and indexed, so it stays cheap as the database grows:

| Sweep | What it does |
|---|---|
| due automation steps | runs the steps that have come due, then records what happened |
| overdue follow-ups | one notification per task, raised once |
| idle leads | alerts the owner when an open lead has gone quiet |
| score decay | re-scores the open leads with the oldest scores, so staleness actually bites |
| leads with no next action | the rule that makes forgetting a lead visible |
| expiring quotations | expires them and tells the owner |
| tomorrow's appointments | the reminder the day before |
| lost-lead recovery | creates the recovery task on the date you chose |
| retention | once a day, removes lost leads past your retention setting, and writes it to the audit log |
| cleanup | idempotency keys older than 2 days, rate-limit windows older than a day, expired sessions, read notifications older than 60 days |

A tick that overlaps the previous one is skipped rather than queued, and a failure
in one sweep is logged without stopping the others.

## Integrations

VoltaFlow never claims something happened when it did not. This is the whole
table of what is real:

| Channel | When connected | When not connected |
|---|---|---|
| **Email (SMTP)** | sends, attaches the quotation PDF, records the message | the send is **refused** with a clear message; the message row is stored with status `blocked` and the reason, and the lead timeline says **"NOT sent"** |
| **WhatsApp Business Cloud** | sends through the Cloud API | the same refusal; no pretending |
| **Telephony** | logs calls automatically | click-to-call still works from the browser; the call is logged manually |
| **AI (Claude)** | summaries, suggested next actions, draft replies | the AI panels say a key is needed and do nothing else |
| **Meta / Google / Make / Zapier** | post leads to the intake endpoint with your API key | nothing to connect — see [`embedding.md`](embedding.md) |

SMTP is **verified against your server** before it is stored as connected: a
wrong password fails at the moment you save it, not silently at 2 a.m. when a
follow-up was supposed to go out.

Automation follows the same rule. A `send_template` step that cannot send writes
the reason into the rule's run log, so "the automation is on" and "the message
went out" are never confused with each other.

## Security

- **Passwords** bcrypt, cost 11. **Access tokens** JWT, 30 minutes.
  **Refresh tokens** httpOnly SameSite cookie, 30 days, stored only as a SHA-256
  hash, revocable per session from the profile screen.
- **Authorisation is server-side.** Every route declares the permission it needs;
  the role matrix is also sent to the client so the UI can hide what the role
  cannot do, but hiding is never the control.
- **Tenant isolation.** Every tenant table carries `org_id`, every query is scoped
  by it, and a test asserts no tenant table is missing the column. A cross-tenant
  read returns 404, so nothing leaks by existence.
- **Input validation** with Zod on every body; identifiers used in dynamic SQL are
  checked against a strict pattern, and every value is bound, never interpolated.
- **Uploads** are type- and size-checked and stored under randomised names.
- **Rate limiting** is fixed-window and stored in the database, so it survives a
  restart: 20 login attempts per 15 minutes per IP + email, 10 signups or
  password-reset requests per hour, 600 authenticated calls per minute per user.
- **Audit log** for sign-ins, permission changes, exports, erasures, integration
  changes, and every write to a lead, quotation or customer.

## GDPR

- **Consent is recorded, not assumed.** The website form's marketing box is
  separate and unticked; the lawful basis is stored on the lead.
- **Operational and marketing messages are separated in the data model.** A
  marketing send without a lawful basis is refused and the refusal is logged. An
  operational message — "your quotation is attached" — is not marketing and is not
  blocked.
- **Subject access**: `GET /api/data/gdpr/subject/:type/:id` returns everything
  held about one person, including activities, messages and quotations.
- **Erasure**: `POST /api/data/gdpr/erase` anonymises the personal data and keeps
  the commercial totals your accountant needs. It requires explicit confirmation
  and is itself audited.
- **Retention**: configurable in Settings for lost leads, applied by the scheduler.
- A privacy-policy link sits on the public form; set it in Settings → Company.

## Deploying

```bash
npm install
npm run build     # client bundle + server typecheck
npm start         # serves the API and the built client from PORT
```

Put it behind a TLS-terminating reverse proxy and set `VF_APP_URL` /
`VF_PUBLIC_URL` to the public origin, so quotation links and embed snippets point
at the right place. The whole application is one Node process plus a directory on
disk; there is no queue, no cache and no second database to operate.

## Tests

```bash
npm test          # 44 domain tests
npm run typecheck # server and client
npm run build     # production build of both
```

The suite covers duplicate detection across phone formats, score explanation and
decay, quotation arithmetic including optional lines and over-discounting, real
PDF bytes, the full automation lifecycle, next-action tracking, pipeline
transitions, tenant isolation, subscription limits and marketing consent.
