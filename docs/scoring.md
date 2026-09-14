# How a lead gets its score

A number between 0 and 100, recomputed whenever anything about the lead changes.

| Band | Score | What it means in practice |
|---|---|---|
| 🔥 Hot | 80–100 | Contact today. The "lead becomes hot" rule notifies the owner and the sales manager the moment it crosses. |
| 🌤 Warm | 50–79 | Worth real effort; keep the sequence running. |
| ❄ Cold | 0–49 | Qualify further before spending time on a site visit. |

**The score is never a black box.** Open any lead and the score ring expands into
the full working: every factor that fired, the points it added or removed, and
the evidence it fired on.

```
Requested a quotation                            +25   asked for a price on the website form
High estimated project value                     +20   €12,400 estimated
Responded to the salesperson                     +15   replied on 11 Sept
Site survey booked                               +15   14 Sept, 10:00
Complete project information                     +12   9 of 9 fields for a PV project
High electricity consumption                     +10   9,800 kWh per year
Interested in more than one product               +8   photovoltaic, battery
Phone and email both provided                     +5
No activity recently                             −20   last activity 9 days ago
                                                 ────
                                                   90   Hot
```

## The factors

Every one of these is editable in **Settings → Lead scoring**: change the points,
change the threshold, or switch a factor off entirely. The same screen shows the
three bands (hot at 80, warm at 50) so you can see where your weights land.

| Factor | Default | Fires when |
|---|---|---|
| Requested a quotation | +25 | the lead asked for a price (the website form sets this), or we have issued one |
| High estimated project value | +20 | `estimated_value` ≥ €8,000 |
| Responded to the salesperson | +15 | the lead has replied at least once |
| Site survey booked | +15 | a survey appointment exists |
| Complete project information | +12 | at least 5 of the fields needed for this project type are filled |
| High electricity consumption | +10 | ≥ 8,000 kWh per year |
| High annual heating cost | +10 | ≥ €1,500 per year |
| Wants to proceed immediately | +12 | the urgency field says so |
| Budget confirmed | +8 | a budget is recorded |
| Interested in more than one product | +8 | e.g. PV **and** a battery |
| Came from a high-converting source | +6 | referral, existing customer, or your own website |
| Phone and email both provided | +5 | both contact routes exist |
| No activity recently | **−20** | nothing has happened for 7 days |
| Repeated failed contact attempts | **−15** | 3 or more unsuccessful attempts |

The two negative factors are the ones that matter most: they are what stops a
stale lead from sitting at 85 because of what it looked like three weeks ago.

## Why these factors

They are the ones that actually predict a sale in this trade:

- **Consumption and heating cost** are the honest proxy for how big the saving is
  — and therefore how motivated the customer is. Someone paying €2,400 a year to
  heat a house with oil converts far better than someone paying €600.
- **A booked survey** is the strongest signal short of a signature. Nobody gives
  up a morning for a system they are not seriously considering.
- **Complete information** matters because an incomplete lead cannot be quoted
  accurately, and an inaccurate quotation is how you lose the job at the survey.
- **Multiple products** (PV + battery, or a heat pump alongside PV) is both a
  bigger job and a more committed customer.

## Missing information

Alongside the score, each lead lists what is still needed before it can be quoted
properly, for its own project type — roof type, orientation, available area,
phase and consumption for PV; heated area, current system and its running cost,
emitters and insulation for a heat pump. That list is what a salesperson should
be collecting on the first call, and it is why "Complete project information" is
worth points.

## When it is recalculated

On creation, on every edit, when an activity is logged, when a survey or
appointment is booked, and when a quotation is sent or answered.

The two negative factors need one more thing, because they fire on the *absence*
of activity: nothing about the lead changes, so nothing would ever recalculate
it. A scheduled sweep therefore re-scores the open leads with the oldest scores,
about twice a day. That is what makes a forgotten hot lead actually cool down —
and because the decay is not something a person did, it does not count as an edit
and does not reset the lead's activity clock.

You can also force a recalculation from the lead page — useful after changing the
rules, to see the effect on a lead you know well.

Changing a scoring rule does **not** silently rewrite history: existing leads keep
their score until they are next recalculated, so a change is visible as it rolls
through rather than as an overnight jump.
