# Putting the form on your website

The lead form is the cheapest place to fix the "we lose leads" problem: the
questions are the ones you would ask on the phone anyway, and every submission
lands in VoltaFlow already assigned, scored and with a follow-up task waiting.

## 1. Get your form token

**Settings → Integrations → Website form.** Copy the snippet, or the token if you
want to build the form yourself. You can rotate the token at any time
(`POST /api/settings/form-token`); the old one stops working immediately.

## 2. Paste two lines

```html
<div id="voltaflow-form"></div>
<script src="https://app.yourdomain.com/embed.js"
        data-voltaflow-token="YOUR_FORM_TOKEN"></script>
```

The script creates an iframe pointing at `/f/<token>`, and nothing else. It
carries no tracking, sets no cookies on your site, and resizes itself through a
single `postMessage` whose origin is checked on both sides. If you prefer, drop
the script and use the iframe directly:

```html
<iframe src="https://app.yourdomain.com/f/YOUR_FORM_TOKEN?embed=1"
        style="width:100%;border:0;min-height:640px" title="Request a quotation"></iframe>
```

## What the visitor sees

Three steps, and the middle one changes with what they pick:

1. **What do you need?** — only the services you have switched on in Settings
   (photovoltaic, heat pump, battery, EV charger, other).
2. **About the project** — PV asks for property type, monthly bill, annual kWh,
   roof material, orientation, available area, phase, existing system, and
   interest in battery, EV charging and backup. A heat pump asks for heated m²,
   floors, the current heating system and its annual cost, emitters, hot water,
   cooling and insulation. Nothing is mandatory except the one or two fields that
   make the enquiry useless without them, so the form is never a wall.
3. **How do we reach you?** — name, phone, email, city, preferred channel, and a
   separate, unticked marketing-consent box with a link to your privacy policy.

Your own custom fields appear here too if you mark them "show in the website
form" (Settings → Custom fields).

## What happens on submit

1. Duplicate check on the normalised phone number and the email. A returning
   customer is **never dropped** — the lead is created and linked to what it
   matched, so the salesperson sees the history instead of a blank record.
2. Assignment by your rules (round-robin, by service, by area, or a fixed owner).
3. Scoring, with the breakdown stored so the salesperson can see why.
4. A first-contact task due in 30 minutes, and a notification to the owner.
5. The acknowledgement email — **only if** email is connected and the lead has a
   lawful basis for it. If it is not connected, nothing is claimed to have been
   sent; the timeline says so.

Submissions are rate-limited to 30 per hour per IP.

## Styling it

The form inherits nothing from your site (it is an iframe), and instead uses your
company logo and name from Settings. It is readable at 320px wide and respects
`prefers-color-scheme`.

---

# Connecting ad platforms and automation tools

Everything below posts to the same endpoint — see
[`api.md`](api.md#lead-intake-server-to-server) for the full field list.

```
POST https://app.yourdomain.com/api/public/intake
X-API-Key: <your API key>
```

## Meta Lead Ads / Google Lead Forms via Make.com or Zapier

1. Trigger: *New Lead* from the ad platform.
2. Action: *HTTP → POST*.
3. URL: your `/api/public/intake`, header `X-API-Key`.
4. Map the fields:

| Ad platform field | VoltaFlow |
|---|---|
| full name / first name | `first_name`, `last_name` |
| phone | `phone` |
| email | `email` |
| city | `city` |
| the "what are you interested in" question | `project_types` (`["pv"]`, `["heat_pump"]`, …) |
| campaign name | `campaign` |
| — | `source`: `meta_ads` or `google_ads` |
| an ad that asked them to request a quotation | `requested_quote: true` |

5. Add a header `Idempotency-Key` set to the platform's own lead id. Make and
   Zapier both retry on failure; with this header a retry returns the original
   lead instead of creating a second one.

If the marketing consent checkbox was part of the ad form, map it to
`consent_marketing`. Do not set it to `true` by default — without a recorded
lawful basis VoltaFlow refuses to send marketing messages to that person, which
is the correct behaviour, not a bug to work around.

## Your own landing page

```js
await fetch('https://app.yourdomain.com/api/public/intake', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-API-Key': process.env.VOLTAFLOW_API_KEY,   // server-side only
    'Idempotency-Key': crypto.randomUUID(),
  },
  body: JSON.stringify({
    first_name: form.firstName, last_name: form.lastName,
    phone: form.phone, email: form.email, city: form.city,
    project_types: ['pv'], source: 'website',
    utm: { utm_source: params.get('utm_source'), utm_campaign: params.get('utm_campaign') },
  }),
});
```

**Call it from your server, never from the browser.** The API key creates leads
under your organisation; in page source it is public. The embedded form exists
precisely so the browser never needs a credential.

## Checking it worked

- **Settings → Integrations** shows the last intake call and its result.
- **Analytics → Sources** shows leads, quotes, wins and revenue per source, so
  within a few weeks you can see which campaign actually pays rather than which
  one produced the most enquiries.
