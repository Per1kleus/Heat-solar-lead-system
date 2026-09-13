import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '../lib/api';
import { useSession } from '../lib/session';
import { Badge, Button, Field, Icon, Modal, useDebounced, useToast } from './ui';
import { ApiError } from '../lib/api';
import { money, relative } from '../lib/format';

const ALL_TYPES = [
  { key: 'pv', label: 'Photovoltaic' },
  { key: 'heat_pump', label: 'Heat pump' },
  { key: 'battery', label: 'Battery' },
  { key: 'ev_charger', label: 'EV charger' },
  { key: 'other', label: 'Other' },
];

export interface LeadFormValues extends Record<string, any> {}

/** Shared create/edit form. Sections follow how an installer actually qualifies. */
export default function LeadForm({
  initial, onClose, onSaved, mode = 'create',
}: {
  initial?: any; onClose: () => void;
  onSaved: (lead: any) => void; mode?: 'create' | 'edit';
}) {
  const { organization, can } = useSession();
  const toast = useToast();
  const services = organization?.services ?? ['pv', 'heat_pump'];

  const [form, setForm] = useState<LeadFormValues>(() => ({
    first_name: '', last_name: '', company: '', phone: '', email: '',
    address: '', city: '', postal_code: '', preferred_contact: 'phone', notes: '',
    source_key: 'manual', campaign: '', owner_id: '', estimated_value: '',
    expected_close_date: '', urgency: 'unknown', budget_known: false, budget_amount: '',
    consent_marketing: false,
    ...numericBlank(initial),
  }));
  const [types, setTypes] = useState<string[]>(initial?.project_types ?? []);
  const [tags, setTags] = useState<string[]>(initial?.tags?.map((t: any) => t.name) ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [forceCreate, setForceCreate] = useState(false);

  const { data: meta } = useQuery({
    queryKey: ['lead-form-meta'],
    queryFn: async () => {
      const [sources, users, fields] = await Promise.all([
        get('/settings/sources'),
        can('leads:assign') ? get('/settings/users') : Promise.resolve({ users: [] }),
        get('/settings/custom-fields'),
      ]);
      return { sources: sources.sources, users: users.users ?? [], customFields: fields.custom_fields ?? [] };
    },
    staleTime: 300_000,
  });

  // Live duplicate check while the phone or email is typed.
  const phone = useDebounced(form.phone, 450);
  const email = useDebounced(form.email, 450);
  const { data: dupes } = useQuery({
    queryKey: ['dupes', phone, email, initial?.id],
    queryFn: () => get(`/leads/duplicates?phone=${encodeURIComponent(phone)}&email=${encodeURIComponent(email)}`),
    enabled: mode === 'create' && ((phone?.length ?? 0) > 5 || (email?.length ?? 0) > 5),
    staleTime: 10_000,
  });
  const duplicates = (dupes?.duplicates ?? []).filter((d: any) => d.id !== initial?.id);

  const set = (key: string) => (e: any) => {
    const value = e?.target?.type === 'checkbox' ? e.target.checked : e?.target?.value ?? e;
    setForm((f) => ({ ...f, [key]: value }));
  };

  const showPv = types.includes('pv') || types.includes('battery') || types.includes('ev_charger');
  const showHp = types.includes('heat_pump');

  const fieldError = (path: string) => error?.fieldError(path);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (types.length === 0) {
      toast.show('Choose at least one product the customer is interested in.', 'error');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...cleanPayload(form),
        project_types: types,
        tags,
        allow_duplicate: forceCreate || duplicates.length === 0,
      };
      const result = mode === 'create'
        ? await post('/leads', payload, { idempotencyKey: `lead-${Date.now()}-${Math.random().toString(36).slice(2)}` })
        : await post(`/leads/${initial.id}`, payload, { method: 'PATCH' } as any);
      toast.success(mode === 'create' ? 'Lead created.' : 'Lead saved.');
      onSaved(result.lead);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err);
        if (err.code === 'conflict') toast.show(err.message, 'error', 'Tick “create anyway” if this really is a new enquiry.');
        else toast.error(err);
      } else toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={mode === 'create' ? 'New lead' : `Edit ${initial?.first_name ?? 'lead'}`}
      subtitle="Capture what you know now — the score and the missing-information list update as you go."
      onClose={onClose}
      width="wide"
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" loading={saving} form="lead-form" type="submit">
            {mode === 'create' ? 'Create lead' : 'Save changes'}
          </Button>
        </>
      }
    >
      <form id="lead-form" onSubmit={submit} className="col gap-8">
        {duplicates.length > 0 && (
          <div className="banner warn">
            <Icon name="alert" size={16} />
            <div className="grow">
              <div className="strong">This contact may already exist</div>
              <div className="col gap-2 mt-2">
                {duplicates.slice(0, 3).map((d: any) => (
                  <div key={d.id} className="row gap-4 small">
                    <Badge outline>{d.type}</Badge>
                    <a href={d.type === 'lead' ? `/app/leads/${d.id}` : `/app/customers/${d.id}`} target="_blank" rel="noreferrer">
                      {d.full_name}
                    </a>
                    <span className="dim">matched on {d.matched_on} · {relative(d.created_at)}{d.owner_name ? ` · ${d.owner_name}` : ''}</span>
                  </div>
                ))}
              </div>
              <label className="check mt-2">
                <input type="checkbox" checked={forceCreate} onChange={(e) => setForceCreate(e.target.checked)} />
                <span>Create anyway — this is a genuinely new enquiry.</span>
              </label>
            </div>
          </div>
        )}

        <section>
          <h3 className="mb-2">Customer</h3>
          <div className="grid c2">
            <Field label="First name" required error={fieldError('first_name')}>
              <input value={form.first_name} onChange={set('first_name')} required autoFocus />
            </Field>
            <Field label="Last name">
              <input value={form.last_name} onChange={set('last_name')} />
            </Field>
            <Field label="Phone" hint="Used for duplicate detection and click-to-call.">
              <input value={form.phone} onChange={set('phone')} inputMode="tel" placeholder="+30 69..." />
            </Field>
            <Field label="Email" error={fieldError('email')}>
              <input type="email" value={form.email} onChange={set('email')} inputMode="email" />
            </Field>
            <Field label="Company (optional)">
              <input value={form.company} onChange={set('company')} />
            </Field>
            <Field label="Preferred contact method">
              <select value={form.preferred_contact} onChange={set('preferred_contact')}>
                <option value="phone">Phone</option>
                <option value="email">Email</option>
                <option value="whatsapp">WhatsApp</option>
                <option value="sms">SMS</option>
              </select>
            </Field>
            <Field label="Installation address">
              <input value={form.address} onChange={set('address')} />
            </Field>
            <div className="grid c2">
              <Field label="City"><input value={form.city} onChange={set('city')} /></Field>
              <Field label="Postal code"><input value={form.postal_code} onChange={set('postal_code')} inputMode="numeric" /></Field>
            </div>
          </div>
          <Field label="Notes">
            <textarea value={form.notes} onChange={set('notes')} rows={2} placeholder="What did they ask for? Anything the next person should know." />
          </Field>
        </section>

        <section>
          <h3 className="mb-2">What are they interested in?</h3>
          <div className="chips mb-4">
            {ALL_TYPES.filter((t) => t.key === 'other' || services.includes(t.key)).map((type) => (
              <button
                key={type.key} type="button"
                className={`chip ${types.includes(type.key) ? 'on' : ''}`}
                onClick={() => setTypes((t) => (t.includes(type.key) ? t.filter((x) => x !== type.key) : [...t, type.key]))}
              >
                {type.label}
              </button>
            ))}
          </div>

          <div className="grid c3">
            <Field label="Estimated value" hint="Your best guess — it drives the pipeline value.">
              <input type="number" min="0" step="100" value={form.estimated_value} onChange={set('estimated_value')} placeholder="0" />
            </Field>
            <Field label="How soon?">
              <select value={form.urgency} onChange={set('urgency')}>
                <option value="unknown">Not sure</option>
                <option value="immediate">Immediately</option>
                <option value="1_3_months">In 1–3 months</option>
                <option value="3_6_months">In 3–6 months</option>
                <option value="later">Later</option>
              </select>
            </Field>
            <Field label="Expected closing date">
              <input type="date" value={form.expected_close_date} onChange={set('expected_close_date')} />
            </Field>
          </div>
          <div className="grid c2 mt-4">
            <label className="check">
              <input type="checkbox" checked={!!form.budget_known} onChange={set('budget_known')} />
              <span>Budget discussed</span>
            </label>
            {form.budget_known && (
              <Field label="Budget">
                <input type="number" min="0" step="500" value={form.budget_amount} onChange={set('budget_amount')} />
              </Field>
            )}
          </div>
        </section>

        {showPv && (
          <section>
            <h3 className="mb-2">Photovoltaic details</h3>
            <div className="grid c3">
              <Field label="Desired system size (kWp)"><input type="number" step="0.5" min="0" value={form.pv_desired_kwp ?? ''} onChange={set('pv_desired_kwp')} /></Field>
              <Field label="Annual consumption (kWh)"><input type="number" step="100" min="0" value={form.pv_annual_kwh ?? ''} onChange={set('pv_annual_kwh')} /></Field>
              <Field label="Monthly electricity bill (€)"><input type="number" step="10" min="0" value={form.pv_monthly_bill ?? ''} onChange={set('pv_monthly_bill')} /></Field>
              <Field label="Roof type">
                <select value={form.pv_roof_type ?? ''} onChange={set('pv_roof_type')}>
                  <option value="">Not known</option>
                  <option value="tile">Tile</option>
                  <option value="flat_concrete">Flat concrete</option>
                  <option value="metal">Metal</option>
                  <option value="shingle">Shingle</option>
                  <option value="ground">Ground mount</option>
                  <option value="carport">Carport</option>
                </select>
              </Field>
              <Field label="Roof orientation">
                <select value={form.pv_roof_orientation ?? ''} onChange={set('pv_roof_orientation')}>
                  <option value="">Not known</option>
                  {['S', 'SE', 'SW', 'E', 'W', 'N', 'mixed'].map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </Field>
              <Field label="Usable roof area (m²)"><input type="number" step="5" min="0" value={form.pv_roof_area_m2 ?? ''} onChange={set('pv_roof_area_m2')} /></Field>
              <Field label="Shading">
                <select value={form.pv_shading ?? ''} onChange={set('pv_shading')}>
                  <option value="">Not known</option>
                  <option value="none">None</option>
                  <option value="partial">Partial</option>
                  <option value="heavy">Heavy</option>
                </select>
              </Field>
              <Field label="Property type">
                <select value={form.pv_property_type ?? ''} onChange={set('pv_property_type')}>
                  <option value="">Not known</option>
                  <option value="detached">Detached house</option>
                  <option value="apartment">Apartment building</option>
                  <option value="commercial">Commercial</option>
                  <option value="industrial">Industrial</option>
                  <option value="agricultural">Agricultural</option>
                </select>
              </Field>
              <Field label="Supply">
                <select value={form.pv_phase ?? ''} onChange={set('pv_phase')}>
                  <option value="">Not known</option>
                  <option value="single">Single phase</option>
                  <option value="three">Three phase</option>
                </select>
              </Field>
              <Field label="Grid connection">
                <select value={form.pv_grid_connection ?? ''} onChange={set('pv_grid_connection')}>
                  <option value="">Not known</option>
                  <option value="net_metering">Net metering</option>
                  <option value="net_billing">Net billing</option>
                  <option value="self_consumption">Self consumption</option>
                  <option value="off_grid">Off grid</option>
                </select>
              </Field>
              <Field label="Installation location">
                <select value={form.pv_install_location ?? ''} onChange={set('pv_install_location')}>
                  <option value="">Not known</option>
                  <option value="roof">Roof</option>
                  <option value="ground">Ground</option>
                  <option value="carport">Carport</option>
                  <option value="facade">Facade</option>
                </select>
              </Field>
              <Field label="Meter / supply number"><input value={form.pv_meter_number ?? ''} onChange={set('pv_meter_number')} /></Field>
            </div>
            <div className="row wrap gap-8 mt-4">
              <label className="check"><input type="checkbox" checked={!!form.pv_existing_system} onChange={set('pv_existing_system')} /><span>Already has a PV system</span></label>
              <label className="check"><input type="checkbox" checked={!!form.battery_interest} onChange={set('battery_interest')} /><span>Interested in a battery</span></label>
              <label className="check"><input type="checkbox" checked={!!form.ev_charger_interest} onChange={set('ev_charger_interest')} /><span>Interested in an EV charger</span></label>
              <label className="check"><input type="checkbox" checked={!!form.backup_power_interest} onChange={set('backup_power_interest')} /><span>Wants backup power</span></label>
            </div>
          </section>
        )}

        {showHp && (
          <section>
            <h3 className="mb-2">Heat-pump details</h3>
            <div className="grid c3">
              <Field label="Existing heating system">
                <select value={form.hp_existing_system ?? ''} onChange={set('hp_existing_system')}>
                  <option value="">Not known</option>
                  <option value="oil_boiler">Oil boiler</option>
                  <option value="gas_boiler">Gas boiler</option>
                  <option value="pellet">Pellet stove</option>
                  <option value="ac_units">Air-conditioning units</option>
                  <option value="electric">Electric heaters</option>
                  <option value="none">Nothing yet</option>
                </select>
              </Field>
              <Field label="Annual heating cost (€)"><input type="number" step="50" min="0" value={form.hp_annual_heating_cost ?? ''} onChange={set('hp_annual_heating_cost')} /></Field>
              <Field label="Heated area (m²)"><input type="number" step="5" min="0" value={form.hp_property_m2 ?? ''} onChange={set('hp_property_m2')} /></Field>
              <Field label="Number of floors"><input type="number" min="1" max="20" value={form.hp_floors ?? ''} onChange={set('hp_floors')} /></Field>
              <Field label="Property type">
                <select value={form.hp_property_type ?? ''} onChange={set('hp_property_type')}>
                  <option value="">Not known</option>
                  <option value="detached">Detached house</option>
                  <option value="apartment">Apartment</option>
                  <option value="commercial">Commercial</option>
                </select>
              </Field>
              <Field label="Emitters">
                <select value={form.hp_emitters ?? ''} onChange={set('hp_emitters')}>
                  <option value="">Not known</option>
                  <option value="radiators">Radiators</option>
                  <option value="underfloor">Underfloor heating</option>
                  <option value="fan_coils">Fan coils</option>
                  <option value="mixed">Mixed</option>
                  <option value="none">Nothing yet</option>
                </select>
              </Field>
              <Field label="Insulation">
                <select value={form.hp_insulation ?? ''} onChange={set('hp_insulation')}>
                  <option value="">Not known</option>
                  <option value="poor">Poor</option>
                  <option value="average">Average</option>
                  <option value="good">Good</option>
                  <option value="excellent">Excellent</option>
                </select>
              </Field>
              <Field label="Estimated power (kW)"><input type="number" step="0.5" min="0" value={form.hp_estimated_kw ?? ''} onChange={set('hp_estimated_kw')} /></Field>
              <Field label="Hot water tank (litres)"><input type="number" step="10" min="0" value={form.hp_dhw_litres ?? ''} onChange={set('hp_dhw_litres')} /></Field>
            </div>
            <div className="row wrap gap-8 mt-4">
              <label className="check"><input type="checkbox" checked={!!form.hp_dhw_required} onChange={set('hp_dhw_required')} /><span>Hot water required</span></label>
              <label className="check"><input type="checkbox" checked={!!form.hp_cooling_required} onChange={set('hp_cooling_required')} /><span>Cooling required</span></label>
              <label className="check"><input type="checkbox" checked={!!form.hp_removal_required} onChange={set('hp_removal_required')} /><span>Remove the old system</span></label>
            </div>
          </section>
        )}

        <section>
          <h3 className="mb-2">Where did this lead come from?</h3>
          <div className="grid c3">
            <Field label="Source">
              <select value={form.source_key} onChange={set('source_key')}>
                {(meta?.sources ?? []).map((s: any) => <option key={s.id} value={s.key}>{s.name}</option>)}
              </select>
            </Field>
            <Field label="Campaign"><input value={form.campaign} onChange={set('campaign')} placeholder="e.g. autumn-pv-athens" /></Field>
            {can('leads:assign') && (
              <Field label="Assign to" hint="Leave blank to use your assignment rules.">
                <select value={form.owner_id} onChange={set('owner_id')}>
                  <option value="">Automatic</option>
                  {(meta?.users ?? []).filter((u: any) => u.status === 'active' && u.role !== 'technician').map((u: any) => (
                    <option key={u.id} value={u.id}>{u.full_name}</option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          <Field label="Tags" hint="Comma separated." >
            <input
              value={tags.join(', ')}
              onChange={(e) => setTags(e.target.value.split(',').map((t) => t.trim()).filter(Boolean))}
              placeholder="vip, roof-access-difficult"
            />
          </Field>
          <label className="check mt-4">
            <input type="checkbox" checked={!!form.consent_marketing} onChange={set('consent_marketing')} />
            <span>
              The customer consented to marketing messages.
              <span className="hint" style={{ display: 'block' }}>
                Leave unticked for a normal enquiry — operational messages about their project are always allowed.
              </span>
            </span>
          </label>
        </section>
      </form>
    </Modal>
  );
}

const NUMERIC_KEYS = [
  'estimated_value', 'budget_amount', 'pv_desired_kwp', 'pv_annual_kwh', 'pv_monthly_bill',
  'pv_roof_area_m2', 'battery_kwh', 'ev_charger_kw', 'hp_annual_heating_cost', 'hp_property_m2',
  'hp_floors', 'hp_estimated_kw', 'hp_dhw_litres',
];

function numericBlank(initial?: any): Record<string, any> {
  if (!initial) return {};
  const out: Record<string, any> = { ...initial };
  for (const key of NUMERIC_KEYS) {
    if (out[key] === null || out[key] === undefined) out[key] = '';
  }
  if (out.expected_close_date) out.expected_close_date = String(out.expected_close_date).slice(0, 10);
  out.source_key = initial.source_key ?? 'manual';
  out.owner_id = initial.owner_id ?? '';
  return out;
}

const ALLOWED = new Set([
  'first_name', 'last_name', 'company', 'phone', 'email', 'address', 'city', 'postal_code',
  'preferred_contact', 'notes', 'source_key', 'campaign', 'owner_id', 'estimated_value',
  'expected_close_date', 'urgency', 'budget_known', 'budget_amount', 'consent_marketing',
  ...NUMERIC_KEYS,
  'pv_roof_type', 'pv_roof_orientation', 'pv_shading', 'pv_property_type', 'pv_phase',
  'pv_grid_connection', 'pv_meter_number', 'pv_install_location', 'pv_existing_system',
  'battery_interest', 'ev_charger_interest', 'backup_power_interest',
  'hp_existing_system', 'hp_property_type', 'hp_emitters', 'hp_insulation',
  'hp_dhw_required', 'hp_cooling_required', 'hp_removal_required',
]);

/** Strips blanks and coerces numbers so the API never sees "" where it expects a number. */
function cleanPayload(form: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(form)) {
    if (!ALLOWED.has(key)) continue;
    if (value === '' || value === null || value === undefined) continue;
    if (NUMERIC_KEYS.includes(key)) {
      const n = Number(value);
      if (!Number.isNaN(n)) out[key] = n;
      continue;
    }
    out[key] = value;
  }
  if (!out.owner_id) delete out.owner_id;
  return out;
}

export { money };
