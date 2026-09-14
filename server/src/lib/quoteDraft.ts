import { all, get, parseJson } from './db.ts';
import { notFound } from './errors.ts';

/**
 * Turns a completed site survey into a quotation the owner can review.
 *
 * The rule that shapes all of this: never invent a number. Quantities come from
 * what the technician actually measured and prices come from the company's own
 * price list. Anything the survey did not establish is still offered as a line —
 * an installer needs the scaffolding line even when nobody wrote down how much —
 * but it is flagged "needs review" with the reason, so the owner edits it rather
 * than sending a guess to a customer.
 */

export interface DraftItem {
  product_template_id: string | null;
  category: string;
  name: string;
  description?: string | null;
  quantity: number;
  unit: string;
  unit_price: number;
  is_optional: boolean;
  /** True when the quantity is a placeholder the owner must confirm. */
  needs_review: boolean;
  review_reason?: string;
}

export interface QuotationDraft {
  survey_id: string;
  lead_id: string | null;
  project_type: string;
  title: string;
  description: string | null;
  notes: string | null;
  items: DraftItem[];
  /** Survey answers that would have improved the quotation but are absent. */
  missing: string[];
  source: {
    completed_at: string | null;
    feasible: boolean | null;
    recommended_system: string | null;
    blockers: string | null;
    technical_notes: string | null;
    customer_preferences: string | null;
    photo_count: number;
    address: string | null;
  };
}

type Products = Record<string, { id: string; name: string; unit: string; unit_price: number; category: string }>;

function loadProducts(orgId: string, projectTypes: string[]): Products {
  const rows = all<any>(
    `SELECT id, project_type, category, name, unit, unit_price FROM product_templates
     WHERE org_id = ? AND is_active = 1 ORDER BY project_type, category`,
    [orgId],
  );
  const map: Products = {};
  for (const row of rows) {
    if (!projectTypes.includes(row.project_type)) continue;
    // Keyed by name so a company that renamed or repriced a line still matches
    // its own catalogue rather than a hard-coded price.
    map[row.name] = row;
  }
  return map;
}

function num(value: any): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function buildQuotationDraft(orgId: string, surveyId: string): QuotationDraft {
  const survey = get<any>('SELECT * FROM site_surveys WHERE id = ? AND org_id = ?', [surveyId, orgId]);
  if (!survey) throw notFound('That site survey no longer exists.');
  const lead = survey.lead_id
    ? get<any>('SELECT * FROM leads WHERE id = ? AND org_id = ?', [survey.lead_id, orgId])
    : null;
  const findings = parseJson<Record<string, any>>(survey.findings, {});
  const leadTypes = parseJson<string[]>(lead?.project_types, []);
  const projectType: string = survey.project_type ?? leadTypes[0] ?? 'pv';

  // Battery and EV charger ride along with a PV survey when the lead asked for them.
  const catalogueTypes = [projectType];
  if (leadTypes.includes('battery') || findings.battery_space) catalogueTypes.push('battery');
  if (leadTypes.includes('ev_charger') || findings.ev_charger_position) catalogueTypes.push('ev_charger');
  const products = loadProducts(orgId, catalogueTypes);

  const items: DraftItem[] = [];
  const missing: string[] = [];

  const add = (
    name: string,
    quantity: number | null,
    reason: string,
    options: { optional?: boolean; description?: string } = {},
  ) => {
    const product = products[name];
    if (!product) return;
    items.push({
      product_template_id: product.id,
      category: product.category,
      name: product.name,
      description: options.description ?? null,
      quantity: quantity ?? 1,
      unit: product.unit,
      unit_price: product.unit_price,
      is_optional: options.optional ?? false,
      needs_review: quantity === null,
      review_reason: quantity === null ? reason : undefined,
    });
    // The per-line reason lives on the line itself. `missing` is the shorter
    // "go back and ask the customer" list, so it is not duplicated here.
  };

  if (projectType === 'heat_pump') {
    const kw = num(findings.heat_loss_kw) ?? num(lead?.hp_estimated_kw);
    add('Air-to-water heat pump 12 kW', kw ? 1 : null,
      'The survey does not record an estimated heat loss, so the unit size is unconfirmed.',
      { description: kw ? `Sized against ${kw} kW estimated heat loss.` : undefined });
    add('Buffer tank 100 L', findings.buffer_tank_space ? 1 : null,
      'The survey does not say whether there is space for a buffer tank.');
    if (findings.dhw_cylinder_space || lead?.hp_dhw_required) {
      add('DHW cylinder 200 L', 1, '');
    }
    add('Hydraulic installation', 1, '');
    add('Electrical installation & controls', 1, '');
    if (findings.removal_required || lead?.hp_removal_required) {
      add('Removal of existing boiler', 1, '');
    }
    add('Commissioning & handover', 1, '');
    if (!num(findings.heat_loss_kw)) {
      pushMissing(missing, 'Estimated heat loss (kW) — needed to size the heat pump.');
    }
    if (!findings.emitters) pushMissing(missing, 'Emitter type — affects the design flow temperature.');
    if (!findings.buffer_tank_space) pushMissing(missing, 'Space for a buffer tank — confirm on site.');
  } else {
    const modules = num(findings.module_count);
    const kwp = num(findings.system_kwp);
    add('PV module 450 Wp (monocrystalline)', modules,
      'The survey does not record how many modules fit, so the array size is unconfirmed.',
      { description: kwp ? `${kwp} kWp array as surveyed.` : undefined });
    add('Hybrid inverter 10 kW', kwp ? 1 : null,
      'The survey does not record a system size, so the inverter is unconfirmed.');
    add('Mounting structure (tiled roof)', kwp,
      'Priced per kWp — the system size is not recorded on the survey.',
      { description: findings.roof_type ? `Roof type: ${findings.roof_type}.` : undefined });
    add('DC/AC protection kit', 1, '');
    add('Mechanical installation', kwp, 'Priced per kWp — the system size is not recorded on the survey.');
    add('Electrical works and cabling', kwp, 'Priced per kWp — the system size is not recorded on the survey.',
      { description: num(findings.distance_to_panel_m) ? `${findings.distance_to_panel_m} m cable run to the panel.` : undefined });
    add('Grid connection paperwork', 1, '');
    add('Monitoring gateway', 1, '', { optional: true });
    add('Annual maintenance (year 1)', 1, '', { optional: true });

    if (!modules) pushMissing(missing, 'Number of modules that fit — needed to price the array.');
    if (!kwp) pushMissing(missing, 'System size in kWp — several lines are priced per kWp.');
    if (!findings.roof_type) pushMissing(missing, 'Roof type — decides the mounting structure.');
    if (!findings.supply_phase) pushMissing(missing, 'Supply phase — decides the inverter and protection.');
  }

  if (findings.battery_space && (leadTypes.includes('battery') || lead?.battery_interest)) {
    add('LFP battery 10 kWh', 1, '', { optional: true });
    add('Battery installation & commissioning', 1, '', { optional: true });
  }
  if (findings.ev_charger_position) {
    add('EV charger 22 kW (3-phase)', 1, '', { optional: true, description: String(findings.ev_charger_position) });
    add('EV charger installation', 1, '', { optional: true });
  }

  const photoCount = get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM documents WHERE org_id = ? AND survey_id = ?', [orgId, survey.id],
  )?.n ?? 0;

  return {
    survey_id: survey.id,
    lead_id: survey.lead_id,
    project_type: projectType,
    title: draftTitle(projectType, findings, survey),
    description: survey.recommended_system ?? null,
    notes: [
      survey.technical_notes ? `Survey notes: ${survey.technical_notes}` : null,
      survey.customer_preferences ? `Customer preferences: ${survey.customer_preferences}` : null,
      survey.blockers ? `Noted on site: ${survey.blockers}` : null,
    ].filter(Boolean).join('\n\n') || null,
    items,
    missing,
    source: {
      completed_at: survey.completed_at,
      feasible: survey.feasible === null ? null : !!survey.feasible,
      recommended_system: survey.recommended_system,
      blockers: survey.blockers,
      technical_notes: survey.technical_notes,
      customer_preferences: survey.customer_preferences,
      photo_count: photoCount,
      address: survey.address,
    },
  };
}

function pushMissing(missing: string[], entry: string): void {
  if (!missing.includes(entry)) missing.push(entry);
}

function draftTitle(projectType: string, findings: Record<string, any>, survey: any): string {
  if (survey.recommended_system) return survey.recommended_system;
  if (projectType === 'heat_pump') {
    const kw = num(findings.heat_loss_kw);
    return kw ? `${kw} kW heat pump system` : 'Heat pump system';
  }
  const kwp = num(findings.system_kwp);
  return kwp ? `${kwp} kWp photovoltaic system` : 'Photovoltaic system';
}
