import { Router } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import { all, get, parseJson, run } from '../lib/db.ts';
import { ah } from '../middleware/errors.ts';
import { rateLimit } from '../middleware/rateLimit.ts';
import { badRequest, notFound, unauthorized } from '../lib/errors.ts';
import { createLead } from '../lib/leads.ts';
import { assertLeadAllowance } from '../lib/billing.ts';
import { sha256 } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { loadQuotation, setQuotationStatus } from '../lib/quotations.ts';
import { renderQuotationPdf } from '../lib/pdf.ts';
import { readIdempotent, writeIdempotent } from '../lib/idempotency.ts';
import { PROJECT_TYPES } from '../lib/defaults.ts';

export const publicRouter = Router();

// --- embeddable lead form -------------------------------------------------

/** Form definition for a company's public token: branding plus the question tree. */
publicRouter.get('/form/:token', rateLimit({ name: 'form_config', windowMs: 60_000, max: 120 }), ah((req, res) => {
  const org = get<any>(
    'SELECT id, name, logo_url, services, privacy_policy_url, city, phone, email FROM organizations WHERE public_form_token = ?',
    [req.params.token],
  );
  if (!org) throw notFound('This form is no longer available.');
  const services = parseJson<string[]>(org.services, ['pv', 'heat_pump']);
  res.json({
    company: {
      name: org.name, logo_url: org.logo_url, city: org.city,
      phone: org.phone, email: org.email, privacy_policy_url: org.privacy_policy_url,
    },
    services: PROJECT_TYPES.filter((t) => t.key === 'other' || services.includes(t.key)),
    questions: FORM_QUESTIONS,
    custom_fields: all(
      "SELECT key, label, type, options, required FROM custom_fields WHERE org_id = ? AND entity = 'lead' AND show_in_form = 1 ORDER BY position",
      [org.id],
    ).map((f: any) => ({ ...f, options: parseJson(f.options, []), required: !!f.required })),
  });
}));

/** The question tree the embedded form walks, keyed by the chosen service. */
export const FORM_QUESTIONS: Record<string, { key: string; label: string; type: string; options?: string[]; help?: string; required?: boolean }[]> = {
  pv: [
    { key: 'pv_property_type', label: 'What type of property is it?', type: 'select', options: ['Detached house', 'Apartment building', 'Commercial', 'Industrial', 'Agricultural'], required: true },
    { key: 'pv_monthly_bill', label: 'Roughly what do you pay for electricity each month?', type: 'number', help: 'In euros. An estimate is fine.' },
    { key: 'pv_annual_kwh', label: 'Do you know your annual consumption in kWh?', type: 'number', help: 'Shown on your electricity bill. Leave blank if unsure.' },
    { key: 'pv_roof_type', label: 'What is the roof made of?', type: 'select', options: ['Tile', 'Flat concrete', 'Metal', 'Shingle', 'Not sure'] },
    { key: 'pv_roof_orientation', label: 'Which way does the roof face?', type: 'select', options: ['South', 'South-east', 'South-west', 'East', 'West', 'Not sure'] },
    { key: 'pv_roof_area_m2', label: 'Approximately how much roof area is available (m²)?', type: 'number' },
    { key: 'pv_phase', label: 'Is your supply single-phase or three-phase?', type: 'select', options: ['Single phase', 'Three phase', 'Not sure'] },
    { key: 'pv_existing_system', label: 'Do you already have a PV system?', type: 'boolean' },
    { key: 'battery_interest', label: 'Are you interested in battery storage?', type: 'boolean' },
    { key: 'ev_charger_interest', label: 'Are you interested in an EV charger?', type: 'boolean' },
    { key: 'backup_power_interest', label: 'Do you need backup power during outages?', type: 'boolean' },
  ],
  heat_pump: [
    { key: 'hp_property_type', label: 'What type of property is it?', type: 'select', options: ['Detached house', 'Apartment', 'Commercial'], required: true },
    { key: 'hp_property_m2', label: 'What is the heated area (m²)?', type: 'number', required: true },
    { key: 'hp_floors', label: 'How many floors?', type: 'number' },
    { key: 'hp_existing_system', label: 'How do you heat the property today?', type: 'select', options: ['Oil boiler', 'Gas boiler', 'Pellet stove', 'Air-conditioning units', 'Electric heaters', 'Nothing yet'] },
    { key: 'hp_annual_heating_cost', label: 'Roughly what do you spend on heating each year?', type: 'number', help: 'In euros.' },
    { key: 'hp_emitters', label: 'What distributes the heat?', type: 'select', options: ['Radiators', 'Underfloor heating', 'Fan coils', 'Mixed', 'Nothing yet'] },
    { key: 'hp_dhw_required', label: 'Do you also need hot water?', type: 'boolean' },
    { key: 'hp_cooling_required', label: 'Do you want cooling in summer as well?', type: 'boolean' },
    { key: 'hp_insulation', label: 'How well insulated is the property?', type: 'select', options: ['Poor', 'Average', 'Good', 'Excellent', 'Not sure'] },
  ],
  battery: [
    { key: 'pv_existing_system', label: 'Do you already have a PV system?', type: 'boolean', required: true },
    { key: 'pv_desired_kwp', label: 'If yes, what size is it (kWp)?', type: 'number' },
    { key: 'battery_kwh', label: 'What storage capacity are you considering (kWh)?', type: 'number' },
    { key: 'backup_power_interest', label: 'Do you need backup power during outages?', type: 'boolean' },
    { key: 'pv_monthly_bill', label: 'Roughly what do you pay for electricity each month?', type: 'number' },
  ],
  ev_charger: [
    { key: 'ev_charger_kw', label: 'What charging power do you need (kW)?', type: 'select', options: ['7.4', '11', '22'] },
    { key: 'pv_phase', label: 'Is your supply single-phase or three-phase?', type: 'select', options: ['Single phase', 'Three phase', 'Not sure'] },
    { key: 'pv_install_location', label: 'Where would the charger be installed?', type: 'select', options: ['Garage', 'Driveway', 'Car park', 'Street side'] },
    { key: 'pv_existing_system', label: 'Do you have a PV system to charge from?', type: 'boolean' },
  ],
  other: [
    { key: 'notes', label: 'Tell us what you need', type: 'textarea', required: true },
  ],
};

const SELECT_MAP: Record<string, Record<string, string>> = {
  pv_property_type: { 'Detached house': 'detached', 'Apartment building': 'apartment', Commercial: 'commercial', Industrial: 'industrial', Agricultural: 'agricultural' },
  pv_roof_type: { Tile: 'tile', 'Flat concrete': 'flat_concrete', Metal: 'metal', Shingle: 'shingle', 'Not sure': 'unknown' },
  pv_roof_orientation: { South: 'S', 'South-east': 'SE', 'South-west': 'SW', East: 'E', West: 'W', 'Not sure': 'unknown' },
  pv_phase: { 'Single phase': 'single', 'Three phase': 'three', 'Not sure': 'unknown' },
  hp_property_type: { 'Detached house': 'detached', Apartment: 'apartment', Commercial: 'commercial' },
  hp_existing_system: { 'Oil boiler': 'oil_boiler', 'Gas boiler': 'gas_boiler', 'Pellet stove': 'pellet', 'Air-conditioning units': 'ac_units', 'Electric heaters': 'electric', 'Nothing yet': 'none' },
  hp_emitters: { Radiators: 'radiators', 'Underfloor heating': 'underfloor', 'Fan coils': 'fan_coils', Mixed: 'mixed', 'Nothing yet': 'none' },
  hp_insulation: { Poor: 'poor', Average: 'average', Good: 'good', Excellent: 'excellent', 'Not sure': 'unknown' },
  pv_install_location: { Garage: 'garage', Driveway: 'driveway', 'Car park': 'car_park', 'Street side': 'street' },
};

const submissionSchema = z.object({
  first_name: z.string().min(1, 'Please tell us your first name.'),
  last_name: z.string().default(''),
  phone: z.string().min(6, 'Please give us a phone number we can reach you on.'),
  email: z.string().email('Please check the email address.').optional().or(z.literal('')),
  city: z.string().optional(),
  address: z.string().optional(),
  postal_code: z.string().optional(),
  preferred_contact: z.enum(['phone', 'email', 'whatsapp']).default('phone'),
  project_types: z.array(z.string()).min(1, 'Choose what you are interested in.'),
  answers: z.record(z.any()).default({}),
  notes: z.string().optional(),
  consent_marketing: z.boolean().default(false),
  utm: z.record(z.string()).optional(),
  campaign: z.string().optional(),
});

publicRouter.post(
  '/form/:token',
  rateLimit({ name: 'form_submit', windowMs: 60 * 60 * 1000, max: 30 }),
  ah((req, res) => {
    const org = get<any>('SELECT id, name FROM organizations WHERE public_form_token = ?', [req.params.token]);
    if (!org) throw notFound('This form is no longer available.');

    const body = submissionSchema.parse(req.body);
    assertLeadAllowance(org.id);
    const mapped = mapAnswers(body.answers);

    const { lead, duplicates } = createLead(
      {
        first_name: body.first_name,
        last_name: body.last_name,
        phone: body.phone,
        email: body.email || null,
        city: body.city,
        address: body.address,
        postal_code: body.postal_code,
        preferred_contact: body.preferred_contact,
        notes: body.notes,
        project_types: body.project_types,
        campaign: body.campaign,
        // Someone who filled in "Request a quotation" has asked for a price. That
        // is the strongest early qualifier there is, so record it rather than
        // waiting until we have sent one.
        requested_quote: 1,
        consent_marketing: body.consent_marketing ? 1 : 0,
        gdpr_basis: 'consent_request',
        utm: body.utm ?? {},
        intake_payload: body,
        ...mapped,
      },
      {
        orgId: org.id,
        channel: 'web_form',
        sourceKey: body.utm?.utm_source === 'google' ? 'google_ads' : 'website',
        // A returning customer must still reach the sales team; the duplicate is
        // flagged on the lead instead of silently dropping the enquiry.
        allowDuplicate: true,
        ip: req.ip,
      },
    );
    if (duplicates.length > 0) {
      run('UPDATE leads SET duplicate_of = ? WHERE id = ?', [
        duplicates.find((d) => d.type === 'lead')?.id ?? null, lead.id,
      ]);
    }
    res.status(201).json({
      ok: true,
      message: `Thank you, ${body.first_name}. Your enquiry has reached ${org.name} and someone will contact you shortly.`,
      reference: lead.reference,
    });
  }),
);

function mapAnswers(answers: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(answers)) {
    if (value === '' || value === null || value === undefined) continue;
    if (SELECT_MAP[key] && typeof value === 'string') {
      const mappedValue = SELECT_MAP[key][value];
      out[key] = mappedValue ?? value;
      continue;
    }
    if (typeof value === 'boolean') { out[key] = value ? 1 : 0; continue; }
    if (key === 'ev_charger_kw' && typeof value === 'string') { out[key] = Number(value); continue; }
    out[key] = value;
  }
  return out;
}

/** The script an installer pastes on their website. Serves a self-contained widget. */
publicRouter.get('/embed.js', ah((_req, res) => {
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(EMBED_SCRIPT);
}));

const EMBED_SCRIPT = `(function () {
  var script = document.currentScript;
  var token = script && script.getAttribute('data-voltaflow-token');
  var target = document.getElementById('voltaflow-form');
  if (!token || !target) return;
  var origin = new URL(script.src).origin;
  var frame = document.createElement('iframe');
  frame.src = origin + '/f/' + token + '?embed=1';
  frame.style.cssText = 'width:100%;border:0;min-height:640px;display:block;';
  frame.setAttribute('title', 'Request a quotation');
  frame.setAttribute('loading', 'lazy');
  target.appendChild(frame);
  window.addEventListener('message', function (event) {
    if (event.origin !== origin || !event.data || event.data.source !== 'voltaflow') return;
    if (event.data.type === 'resize' && typeof event.data.height === 'number') {
      frame.style.height = event.data.height + 'px';
    }
  });
})();`;

// --- intake API / webhook -------------------------------------------------

/**
 * Server-to-server lead intake for landing pages, Make.com, Zapier and ad
 * platforms. Authenticated with the organisation's API key.
 */
publicRouter.post(
  '/intake',
  rateLimit({ name: 'intake', windowMs: 60_000, max: 120, key: (req) => String(req.headers['x-api-key'] ?? req.ip) }),
  ah((req, res) => {
    const apiKey = (req.headers['x-api-key'] as string) ?? '';
    if (!apiKey) throw unauthorized('Send your VoltaFlow API key in the X-API-Key header.');
    const org = get<{ id: string }>('SELECT id FROM organizations WHERE api_key_hash = ?', [sha256(apiKey)]);
    if (!org) throw unauthorized('That API key is not valid.');

    const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
    const cached = readIdempotent<any>(org.id, idempotencyKey);
    if (cached) return res.status(200).json(cached);

    const body = z.object({
      first_name: z.string().min(1),
      last_name: z.string().default(''),
      phone: z.string().optional(),
      email: z.string().email().optional(),
      company: z.string().optional(),
      city: z.string().optional(),
      address: z.string().optional(),
      postal_code: z.string().optional(),
      source: z.string().optional(),
      campaign: z.string().optional(),
      project_types: z.array(z.string()).default([]),
      estimated_value: z.number().optional(),
      notes: z.string().optional(),
      consent_marketing: z.boolean().optional(),
      requested_quote: z.boolean().optional(),
      fields: z.record(z.any()).optional(),
      utm: z.record(z.string()).optional(),
    }).parse(req.body);

    assertLeadAllowance(org.id);
    const sourceKey = body.source && get('SELECT 1 FROM lead_sources WHERE org_id = ? AND key = ?', [org.id, body.source])
      ? body.source
      : 'other';

    const { lead, duplicates } = createLead(
      {
        ...body,
        ...(body.fields ?? {}),
        consent_marketing: body.consent_marketing ? 1 : 0,
        requested_quote: body.requested_quote ? 1 : 0,
        intake_payload: body,
      },
      { orgId: org.id, channel: 'api', sourceKey, allowDuplicate: true, ip: req.ip },
    );

    const payload = {
      ok: true,
      lead: { id: lead.id, reference: lead.reference, owner_id: lead.owner_id, score: lead.score, temperature: lead.temperature },
      duplicates: duplicates.map((d) => ({ id: d.id, type: d.type, matched_on: d.matched_on })),
    };
    writeIdempotent(org.id, idempotencyKey, 'POST /intake', payload);
    res.status(201).json(payload);
  }),
);

// --- public quotation view ------------------------------------------------

/** Customer-facing quotation link. Viewing it records the view on the timeline. */
publicRouter.get('/quote/:token', rateLimit({ name: 'quote_view', windowMs: 60_000, max: 60 }), ah((req, res) => {
  const row = get<{ id: string; org_id: string; status: string; valid_until: string | null }>(
    'SELECT id, org_id, status, valid_until FROM quotations WHERE public_token = ?', [req.params.token],
  );
  if (!row) throw notFound('This quotation link is no longer valid.');
  if (row.status === 'draft') throw notFound('This quotation has not been issued yet.');

  const quote = loadQuotation(row.org_id, row.id);
  const org = get<any>('SELECT name, logo_url, address, city, postal_code, phone, email, website, vat_number FROM organizations WHERE id = ?', [row.org_id]);

  if (!quote.first_viewed_at) {
    setQuotationStatus(row.org_id, row.id, null, 'viewed');
  }
  run('UPDATE quotations SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?', [nowIso(), row.id]);

  const expired = row.valid_until ? new Date(row.valid_until) < new Date() : false;
  res.json({
    quotation: {
      number: quote.number, title: quote.title, description: quote.description,
      items: quote.items, subtotal: quote.subtotal, discount_amount: quote.discount_amount,
      vat_rate: quote.vat_rate, vat_amount: quote.vat_amount, total: quote.total,
      optional_total: quote.optional_total, currency: quote.currency,
      valid_until: quote.valid_until, terms: quote.terms, notes: quote.notes,
      status: quote.status, customer_name: quote.customer_name, owner_name: quote.owner_name,
      expired,
    },
    company: org,
  });
}));

publicRouter.get('/quote/:token/pdf', rateLimit({ name: 'quote_pdf', windowMs: 60_000, max: 30 }), ah(async (req, res) => {
  const row = get<{ id: string; org_id: string; number: string; status: string }>(
    'SELECT id, org_id, number, status FROM quotations WHERE public_token = ?', [req.params.token],
  );
  if (!row || row.status === 'draft') throw notFound('This quotation link is no longer valid.');
  const path = await renderQuotationPdf(row.org_id, row.id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${row.number}.pdf"`);
  fs.createReadStream(path).pipe(res);
}));

publicRouter.post('/quote/:token/respond', rateLimit({ name: 'quote_respond', windowMs: 60_000, max: 10 }), ah((req, res) => {
  const body = z.object({
    decision: z.enum(['accepted', 'rejected']),
    note: z.string().max(2000).optional(),
  }).parse(req.body);
  const row = get<{ id: string; org_id: string; status: string; valid_until: string | null }>(
    'SELECT id, org_id, status, valid_until FROM quotations WHERE public_token = ?', [req.params.token],
  );
  if (!row) throw notFound('This quotation link is no longer valid.');
  if (['accepted', 'rejected'].includes(row.status)) {
    throw badRequest('This quotation has already been answered. Please contact us if anything has changed.');
  }
  if (row.valid_until && new Date(row.valid_until) < new Date()) {
    throw badRequest('This quotation has expired. Please contact us for an up-to-date price.');
  }
  setQuotationStatus(row.org_id, row.id, null, body.decision, { rejection_reason: body.note ?? null });
  res.json({
    ok: true,
    message: body.decision === 'accepted'
      ? 'Thank you. We have received your acceptance and will be in touch to arrange the installation.'
      : 'Thank you for letting us know. We will be in touch shortly.',
  });
}));

export { nowIso };
