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

### Actions

| `type` | Fields | Notes |
|---|---|---|
| `create_task` | `title`, `task_type`, `priority`, `due_in_minutes`, `description` | this is the workhorse |
| `notify_owner` | `title`, `body`, `severity`, `notification_type` | |
| `notify_assignee` | `title`, `body`, `severity` | for task-based triggers |
| `notify_managers` | `title`, `body`, `severity` | owners, admins and sales managers |
| `send_template` | `template_key`, `channel`, `purpose` | **honest**: see below |
| `change_stage` | `stage_key` | |
| `add_tag` | `tag` | |
| `schedule_recovery` | — | creates the recovery task on the lost lead's recovery date |
| `stop_sales_automations` | — | ends the sales sequences and creates the customer record |

### Stop conditions

`contacted`, `customer_replied`, `appointment_booked`, `quote_responded`,
`won`, `lost`, `paused`. `paused` is the per-lead switch on the lead page —
a salesperson who is handling something delicately can turn the machine off for
that one lead without disabling the rule for everyone.

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

You can edit any of them, switch them off, or write your own; the eight are
marked as system rules only so they can be restored.

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

## Guarantees worth knowing

- **A lead is enrolled in a rule once.** A unique index on
  `(rule_id, lead_id, quotation_id)` makes re-enrolment a no-op, so a lead that
  bounces in and out of a stage does not collect duplicate task chains.
- **A retried step cannot duplicate a task.** Each step carries a dedupe key.
- **The scheduler is the only clock.** Steps become due; a sweep executes them.
  Nothing runs inside the HTTP request that triggered it, so a slow send can
  never slow down the person using the app.
- **Nothing is lost across a restart.** Due steps are stored, not held in memory.
