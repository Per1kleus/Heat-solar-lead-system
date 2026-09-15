# The follow-up engine

The engine exists for one reason: a salesperson should not be able to forget a
lead. It does that by creating **real tasks with real due dates** rather than by
sending a stream of messages — the eight rules that ship switched on create 23
tasks and notifications and send at most one message to the customer.

> Marketing sends are refused unless the person has a recorded lawful basis, and
> the refusal is written to the audit log. The engine is not a broadcast tool.

## The shape of a rule

```json
{
  "name": "Chase the survey report",
  "trigger_type": "stage_changed",
  "trigger_config": { "stage": "site_survey" },
  "conditions": [{ "field": "estimated_value", "op": "gte", "value": 8000 }],
  "steps": [
    { "delay_minutes": 2880, "stop_if": ["contacted"], "actions": [
      { "type": "create_task", "title": "Write up the survey for {{lead.full_name}}",
        "task_type": "follow_up", "priority": "high" }
    ] },
    { "delay_minutes": 7200, "actions": [
      { "type": "notify_managers", "severity": "warning",
        "title": "Survey report still outstanding", "body": "{{lead.full_name}} — {{lead.value}}" }
    ] }
  ],
  "stop_on": ["won", "lost", "paused"]
}
```

A rule **enrols** a lead when its trigger fires and its conditions hold. Each
step runs `delay_minutes` after enrolment. A step is skipped if its `stop_if`
already holds; the whole run stops if anything in `stop_on` holds.

### Triggers

| `trigger_type` | Fires when | `trigger_config` |
|---|---|---|
| `lead_created` | a lead arrives from any channel | — |
| `stage_changed` | a lead enters a stage | `{ "stage": "<stage key>" }` |
| `temperature_changed` | the score crosses a band | `{ "to": "hot" \| "warm" \| "cold" }` |
| `quote_sent` | a quotation is sent or recorded as sent | — |
| `lead_won` | a deal is won | — |
| `lead_lost` | a lead is marked lost | — |
| `task_overdue` | a follow-up passes its due date | — |
| `lead_idle` | nothing has happened on an open lead | `{ "hours": 24 }` |
| `no_next_action` | an open lead has no open task | — |
| `appointment_scheduled` | a survey or meeting is booked | — |
| `appointment_reminder_due` | an appointment is coming up tomorrow | — |
| `installation_completed` | a job is handed over to the customer | — |

### Actions

| `type` | Fields | Notes |
|---|---|---|
| `create_task` | `title`, `task_type`, `priority`, `due_in_minutes`, `description` | this is the workhorse |
| `notify_owner` | `title`, `body`, `severity`, `notification_type` | |
| `notify_assignee` | `title`, `body`, `severity` | for task-based triggers |
| `notify_managers` | `title`, `body`, `severity` | owners, admins and sales managers |
| `send_template` | `template_key`, `channel`, `purpose` | **honest**: see below. `channel: "preferred"` uses the customer's own choice |
| `change_stage` | `stage_key` | |
| `add_tag` | `tag` | |
| `schedule_recovery` | — | creates the recovery task on the lost lead's recovery date |
| `stop_sales_automations` | — | ends the sales sequences and creates the customer record |

### Stop conditions

`contacted`, `customer_replied`, `appointment_booked`, `quote_responded`,
`won`, `lost`, `paused`, `opted_out`, `appointment_cancelled`.

`paused` is the per-lead switch on the lead page — a salesperson handling
something delicately can turn the machine off for that one lead without disabling
the rule for everyone. `opted_out` is the customer's own "do not contact me
automatically": unlike the rest it is **not** optional, because setting it stops
every running sequence for that contact whatever the rules say. A person can
still write to them by hand.

You can also stop one sequence and leave the others running — the Automation tab
on any lead lists them with their next scheduled step, everything they have
already done, anything that failed, and a Stop button.

### Placeholders

`{{lead.full_name}}`, `{{lead.first_name}}`, `{{lead.value}}`, `{{lead.score}}`,
`{{lead.project_summary}}`, `{{lead.city}}`, `{{lead.score}}`,
`{{company.name}}`, `{{company.phone}}`, `{{company.website}}`,
`{{quote.number}}`, `{{quote.total}}`, `{{quote.valid_until}}`,
`{{task.title}}`, `{{task.due_human}}`, `{{user.name}}`,
`{{appointment.date}}`. Any other column on those records works too
(`{{lead.postal_code}}`, `{{quote.title}}`, …). An unknown placeholder renders as empty
text rather than leaking `{{…}}` to a customer.

## The eight rules that ship on

1. **New lead** — assign, notify the owner, first-contact call due in 30 minutes,
   acknowledgement email; then a "not contacted yet" alert at 30 minutes and
   follow-up tasks on day 1, 3, 7 and 14. Stops as soon as the lead is contacted.
2. **Lead untouched** — no activity for 24 hours (configurable) alerts the owner.
3. **Lead becomes hot** — owner and sales managers notified immediately.
4. **Quotation sent** — day 2, 5, 10 and 20 follow-ups, with a "still unanswered"
   alert on the last one. Stops the moment the customer answers.
5. **Follow-up overdue** — notifies the assignee the moment a task goes past due.
6. **Lost lead** — creates the recovery task on the date you chose.
7. **Deal won** — records revenue, stops the sales sequences, creates the customer
   and opens the installation handover.
8. **No next action** — flags the lead so the dashboard can surface it.

Plus one more that ships on: **appointment reminder** — the evening before a
booked visit the customer gets a single reminder on their preferred channel.

You can edit any of them, switch them off, or write your own; they are marked as
system rules only so they can be restored.

## The customer-messaging sequences (off by default)

Three further sequences ship **switched off**, because they send real messages to
real customers:

| Rule | What it does |
|---|---|
| **New lead — message the customer on day 1, 3, 7 and 14** | chases an unanswered enquiry on their preferred channel |
| **Quotation sent — message the customer on day 2, 5, 10 and 20** | chases an unanswered quotation |
| **Installation completed — check in three weeks later** | one message asking whether everything works |

Switch them on in Automation once a channel is connected and you are happy with
the wording. Every step stops the moment the customer replies, books a visit,
answers the quotation, or the deal is won or lost — and an opted-out contact is
never messaged at all. Of everything the *default* rules do, exactly two actions
send anything to a customer: the acknowledgement when the enquiry arrives, and
the reminder before a visit they booked.

## What actually happens when a rule runs

Open **Automation → Details → Runs** on any rule. Each run shows the lead, when
it was enrolled, which steps executed and — this is the point — **what the result
was**, not what was intended:

```
13 Sept 09:41  step 1  created task "First contact: call Nikos Antoniou"
13 Sept 09:41  step 1  notified Alexis Papadopoulos
13 Sept 09:41  step 1  template "lead_acknowledgement" not sent: email is not connected
13 Sept 10:11  step 2  skipped — the lead was contacted
```

A `send_template` action writes the real outcome of the send, including the
reason it did not go out. An automation that shows as active is genuinely
running; one that could not do something says so.

## Pausing, resuming and stopping

Each lead's Automation tab lists its sequences with the next scheduled step,
everything that has already run, anything that failed, and three controls:

| | What it does |
|---|---|
| **Pause** | holds the sequence where it is. It leaves the scheduler's reach, keeps its step, and remembers when it was paused |
| **Resume** | puts it back with whatever delay was left — a step that had three days to go still has three days, not "overdue" |
| **Stop** | ends it, with the reason recorded |

Pausing the whole lead does the same to all of its sequences at once. None of
this ends anything: a paused sequence is still `active`, just not scheduled.

## Guarantees worth knowing

- **A lead is enrolled in a rule once.** A flattened run key over
  `(rule, lead, quotation, appointment)` makes re-enrolment a no-op, so a lead
  that bounces in and out of a stage does not collect duplicate task chains —
  while two different appointments still each get their own reminder.
- **A retried step cannot duplicate a task.** Each step carries a dedupe key.
- **A customer is never messaged twice for one scheduled action.** Every
  customer-facing send claims `run:step:send:template` *before* the provider is
  called. A duplicated tick, a worker retry or a restart mid-send lands on the
  same claim and replays the original outcome instead of sending again. The key
  is never derived from the message content, so a genuinely different step —
  the day-5 chase after the day-2 one — still sends.
- **A transient failure is retried, a permanent one is not.** A timeout or a 5xx
  is tried up to three times; a rejected recipient, a refused login or an opt-out
  is recorded once and left alone.
- **A template it cannot fill is refused.** If an essential placeholder — a name,
  a quotation number or total, an appointment date — resolves empty, the
  automated send is refused with a note of which field is missing, rather than
  posting "Hello , your quotation  totals " to a customer. Someone composing by
  hand sees the same text and can fix it themselves.
- **The scheduler is the only clock.** Steps become due; a sweep executes them.
  Nothing runs inside the HTTP request that triggered it, so a slow send can
  never slow down the person using the app.
- **Nothing is lost across a restart.** Due steps are stored, not held in memory.
- **A channel is resolved before the step runs**, so the log names the channel
  that was actually used, and a contact with no phone or email is reported rather
  than silently skipped.
- **An opt-out wins over the rule.** It is checked when the step runs and again
  inside the send, so a sequence that was already in flight still cannot message
  someone who asked not to be.
