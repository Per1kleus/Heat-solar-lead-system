import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { get, post, patch } from '../lib/api';
import { useSession } from '../lib/session';
import { Badge, Button, Field, Icon, Modal, useDebounced, useToast } from './ui';
import { money, toInputDate } from '../lib/format';

interface Line {
  key: string;
  category: string;
  name: string;
  description?: string;
  quantity: number;
  unit: string;
  unit_price: number;
  discount_pct: number;
  is_optional: boolean;
}

const CATEGORIES = [
  { key: 'equipment', label: 'Equipment' },
  { key: 'installation', label: 'Installation' },
  { key: 'electrical', label: 'Electrical' },
  { key: 'civil', label: 'Civil works' },
  { key: 'service', label: 'Service' },
  { key: 'other', label: 'Other' },
];

let lineCounter = 0;
const newLine = (partial: Partial<Line> = {}): Line => ({
  key: `line-${++lineCounter}`,
  category: 'equipment', name: '', quantity: 1, unit: 'pcs',
  unit_price: 0, discount_pct: 0, is_optional: false,
  ...partial,
});

/** Quotation builder. Totals are computed locally for instant feedback and
 *  recomputed authoritatively on the server when saved. */
export default function QuotationBuilder({
  leadId, quotation, onClose, onSaved,
}: {
  leadId?: string; quotation?: any;
  onClose: () => void; onSaved: (quote: any) => void;
}) {
  const { organization } = useSession();
  const toast = useToast();
  const currency = organization?.currency ?? 'EUR';

  const [selectedLead, setSelectedLead] = useState<string | undefined>(leadId ?? quotation?.lead_id);
  const [leadSearch, setLeadSearch] = useState('');
  const debouncedLead = useDebounced(leadSearch, 300);
  const [title, setTitle] = useState(quotation?.title ?? '');
  const [description, setDescription] = useState(quotation?.description ?? '');
  const [lines, setLines] = useState<Line[]>(
    quotation?.items?.length
      ? quotation.items.map((item: any) => newLine({
          category: item.category, name: item.name, description: item.description ?? undefined,
          quantity: item.quantity, unit: item.unit, unit_price: item.unit_price,
          discount_pct: item.discount_pct, is_optional: item.is_optional,
        }))
      : [newLine()],
  );
  const [discountType, setDiscountType] = useState<'amount' | 'percent'>(quotation?.discount_type ?? 'amount');
  const [discountValue, setDiscountValue] = useState<number>(quotation?.discount_value ?? 0);
  const [vatRate, setVatRate] = useState<number>(quotation?.vat_rate ?? organization?.vat_rate ?? 24);
  const [validUntil, setValidUntil] = useState(toInputDate(quotation?.valid_until) || '');
  const [terms, setTerms] = useState(quotation?.terms ?? '');
  const [notes, setNotes] = useState(quotation?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [showCatalogue, setShowCatalogue] = useState(false);

  const { data: leadResults } = useQuery({
    queryKey: ['quote-lead-search', debouncedLead],
    queryFn: () => get(`/leads?search=${encodeURIComponent(debouncedLead)}&limit=8`),
    enabled: !selectedLead && debouncedLead.trim().length >= 2,
  });

  const { data: leadData } = useQuery({
    queryKey: ['quote-lead', selectedLead],
    queryFn: () => get(`/leads/${selectedLead}`),
    enabled: Boolean(selectedLead),
  });

  const { data: catalogue } = useQuery({
    queryKey: ['products'],
    queryFn: () => get('/quotations/meta/products'),
    staleTime: 300_000,
  });

  const { data: company } = useQuery({
    queryKey: ['company-defaults'],
    queryFn: () => get('/settings/company'),
    staleTime: 300_000,
  });

  // Seed the title and terms from the lead once it is known.
  useEffect(() => {
    if (!leadData?.lead || title) return;
    const lead = leadData.lead;
    const parts: string[] = [];
    if (lead.pv_desired_kwp) parts.push(`${lead.pv_desired_kwp} kWp photovoltaic system`);
    else if (lead.project_types?.includes('pv')) parts.push('Photovoltaic system');
    if (lead.battery_kwh) parts.push(`${lead.battery_kwh} kWh battery storage`);
    else if (lead.battery_interest) parts.push('battery storage');
    if (lead.hp_estimated_kw) parts.push(`${lead.hp_estimated_kw} kW heat pump`);
    else if (lead.project_types?.includes('heat_pump')) parts.push('heat pump');
    if (lead.ev_charger_interest) parts.push('EV charger');
    setTitle(parts.length ? parts.join(' with ').replace(/^(.)/, (c) => c.toUpperCase()) : 'Energy system proposal');
  }, [leadData, title]);

  useEffect(() => {
    if (company?.company && !terms) setTerms(company.company.quote_terms ?? '');
    if (company?.company && !validUntil) {
      const d = new Date();
      d.setDate(d.getDate() + (company.company.quote_validity_days ?? 30));
      setValidUntil(d.toISOString().slice(0, 10));
    }
  }, [company]);

  const totals = useMemo(() => {
    const priced = lines.map((line) => ({
      ...line,
      line_total: round2(line.quantity * line.unit_price * (1 - line.discount_pct / 100)),
    }));
    const subtotal = round2(priced.filter((l) => !l.is_optional).reduce((s, l) => s + l.line_total, 0));
    const optional = round2(priced.filter((l) => l.is_optional).reduce((s, l) => s + l.line_total, 0));
    const discount = discountType === 'percent' ? round2(subtotal * (discountValue / 100)) : round2(discountValue);
    const net = Math.max(0, round2(subtotal - discount));
    const vat = round2(net * (vatRate / 100));
    return { priced, subtotal, optional, discount, net, vat, total: round2(net + vat) };
  }, [lines, discountType, discountValue, vatRate]);

  const update = (key: string, patchLine: Partial<Line>) =>
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patchLine } : line)));

  const save = async () => {
    if (!selectedLead) return toast.show('Choose which lead this quotation is for.', 'error');
    if (!title.trim()) return toast.show('Give the quotation a title.', 'error');
    const valid = lines.filter((line) => line.name.trim() && line.quantity > 0);
    if (valid.length === 0) return toast.show('Add at least one priced line.', 'error');

    setSaving(true);
    try {
      const payload = {
        lead_id: selectedLead,
        title: title.trim(),
        description: description || undefined,
        items: valid.map(({ key, ...line }, index) => ({ ...line, position: index })),
        discount_type: discountType,
        discount_value: Number(discountValue) || 0,
        vat_rate: Number(vatRate),
        valid_until: validUntil ? new Date(validUntil).toISOString() : undefined,
        terms: terms || undefined,
        notes: notes || undefined,
      };
      const result = quotation
        ? await patch(`/quotations/${quotation.id}`, payload)
        : await post('/quotations', payload, { idempotencyKey: `quote-${selectedLead}-${title}-${totals.total}` });
      toast.success(quotation ? 'Quotation updated.' : 'Quotation created.');
      onSaved(result.quotation);
    } catch (err) {
      toast.error(err);
    } finally {
      setSaving(false);
    }
  };

  const products = catalogue?.products ?? [];
  const suggestedTypes: string[] = leadData?.lead?.project_types ?? [];

  return (
    <Modal
      title={quotation ? `Edit ${quotation.number}` : 'New quotation'}
      subtitle={leadData?.lead ? `For ${leadData.lead.full_name}${leadData.lead.city ? ` · ${leadData.lead.city}` : ''}` : undefined}
      onClose={onClose} width="wide"
      footer={
        <>
          <div className="grow small">
            <strong style={{ fontSize: 16 }}>{money(totals.total, currency, 2)}</strong>
            <span className="muted"> including {vatRate}% VAT</span>
            {totals.optional > 0 && <span className="dim"> · {money(totals.optional, currency, 2)} optional</span>}
          </div>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={save}>
            {quotation ? 'Save changes' : 'Create quotation'}
          </Button>
        </>
      }
    >
      <div className="col gap-8">
        {!leadId && !quotation && (
          <Field label="Which lead is this for?" required>
            {selectedLead && leadData?.lead ? (
              <div className="row gap-4">
                <Badge tone="accent">{leadData.lead.full_name}</Badge>
                <span className="small dim">{leadData.lead.reference} · {leadData.lead.city ?? 'no city'}</span>
                <Button size="sm" variant="ghost" onClick={() => { setSelectedLead(undefined); setLeadSearch(''); }}>Change</Button>
              </div>
            ) : (
              <>
                <input value={leadSearch} onChange={(e) => setLeadSearch(e.target.value)} placeholder="Search by name, phone or reference…" autoFocus />
                {(leadResults?.leads ?? []).length > 0 && (
                  <div className="chips mt-2">
                    {leadResults.leads.map((lead: any) => (
                      <button key={lead.id} type="button" className="chip" onClick={() => setSelectedLead(lead.id)}>
                        {lead.full_name} · {lead.city ?? '—'} · {money(lead.estimated_value, currency)}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </Field>
        )}

        <div className="grid c2">
          <Field label="Title" required hint="What the customer sees at the top of the PDF.">
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="10 kWp photovoltaic system with 10 kWh battery" />
          </Field>
          <Field label="Valid until">
            <input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
          </Field>
        </div>

        <Field label="Introduction (optional)">
          <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Following our site survey of 12 Ethnikis Antistaseos…" />
        </Field>

        {/* ---- line items ---- */}
        <div>
          <div className="row between mb-2">
            <h3>Scope and pricing</h3>
            <div className="row gap-4">
              <Button size="sm" icon="grid" onClick={() => setShowCatalogue((v) => !v)}>
                {showCatalogue ? 'Hide price list' : 'Add from price list'}
              </Button>
              <Button size="sm" icon="plus" onClick={() => setLines((l) => [...l, newLine()])}>Blank line</Button>
            </div>
          </div>

          {showCatalogue && (
            <div className="card mb-4" style={{ padding: 10, maxHeight: 220, overflowY: 'auto' }}>
              {['pv', 'battery', 'heat_pump', 'ev_charger']
                .sort((a, b) => Number(suggestedTypes.includes(b)) - Number(suggestedTypes.includes(a)))
                .map((type) => {
                  const items = products.filter((p: any) => p.project_type === type);
                  if (items.length === 0) return null;
                  return (
                    <div key={type} className="mb-4">
                      <div className="tiny dim strong mb-2" style={{ textTransform: 'uppercase', letterSpacing: '.05em' }}>
                        {type.replace('_', ' ')}{suggestedTypes.includes(type) ? ' · suggested for this lead' : ''}
                      </div>
                      <div className="chips">
                        {items.map((product: any) => (
                          <button
                            key={product.id} type="button" className="chip"
                            onClick={() => setLines((l) => [
                              ...l.filter((line) => line.name.trim() || l.length === 1 ? true : false),
                              newLine({
                                category: product.category, name: product.name,
                                unit: product.unit, unit_price: product.unit_price,
                              }),
                            ].filter((line, index, arr) => line.name.trim() !== '' || index === arr.length - 1))}
                          >
                            {product.name} · {money(product.unit_price, currency)}/{product.unit}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
            </div>
          )}

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th style={{ minWidth: 200 }}>Description</th>
                  <th style={{ width: 110 }}>Category</th>
                  <th className="num" style={{ width: 80 }}>Qty</th>
                  <th style={{ width: 80 }}>Unit</th>
                  <th className="num" style={{ width: 100 }}>Unit price</th>
                  <th className="num" style={{ width: 70 }}>Disc %</th>
                  <th className="num" style={{ width: 100 }}>Total</th>
                  <th style={{ width: 70 }}>Optional</th>
                  <th style={{ width: 40 }} />
                </tr>
              </thead>
              <tbody>
                {totals.priced.map((line) => (
                  <tr key={line.key} style={{ cursor: 'default' }}>
                    <td>
                      <input
                        value={line.name} onChange={(e) => update(line.key, { name: e.target.value })}
                        placeholder="PV module 450 Wp" aria-label="Line description"
                      />
                      <input
                        className="small" value={line.description ?? ''}
                        onChange={(e) => update(line.key, { description: e.target.value })}
                        placeholder="Optional detail shown under the line"
                        style={{ marginTop: 4, fontSize: 12 }}
                      />
                    </td>
                    <td>
                      <select value={line.category} onChange={(e) => update(line.key, { category: e.target.value })} aria-label="Category">
                        {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                      </select>
                    </td>
                    <td>
                      <input
                        type="number" min="0" step="0.01" value={line.quantity}
                        onChange={(e) => update(line.key, { quantity: Number(e.target.value) })}
                        style={{ textAlign: 'right' }} aria-label="Quantity"
                      />
                    </td>
                    <td>
                      <input value={line.unit} onChange={(e) => update(line.key, { unit: e.target.value })} aria-label="Unit" />
                    </td>
                    <td>
                      <input
                        type="number" min="0" step="0.01" value={line.unit_price}
                        onChange={(e) => update(line.key, { unit_price: Number(e.target.value) })}
                        style={{ textAlign: 'right' }} aria-label="Unit price"
                      />
                    </td>
                    <td>
                      <input
                        type="number" min="0" max="100" step="1" value={line.discount_pct}
                        onChange={(e) => update(line.key, { discount_pct: Number(e.target.value) })}
                        style={{ textAlign: 'right' }} aria-label="Line discount"
                      />
                    </td>
                    <td className="num strong nowrap">{money(line.line_total, currency, 2)}</td>
                    <td className="center">
                      <input
                        type="checkbox" checked={line.is_optional}
                        onChange={(e) => update(line.key, { is_optional: e.target.checked })}
                        aria-label="Optional item"
                      />
                    </td>
                    <td>
                      <Button
                        size="sm" variant="ghost" icon="trash" aria-label="Remove line"
                        onClick={() => setLines((l) => (l.length === 1 ? [newLine()] : l.filter((x) => x.key !== line.key)))}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* ---- totals ---- */}
        <div className="grid c2" style={{ alignItems: 'start' }}>
          <div className="col gap-6">
            <Field label="Notes to the customer">
              <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Lead time, what is excluded, anything agreed on the phone." />
            </Field>
            <Field label="Terms and conditions">
              <textarea rows={5} value={terms} onChange={(e) => setTerms(e.target.value)} />
            </Field>
          </div>

          <div className="card" style={{ padding: 14 }}>
            <div className="grid c2 mb-4">
              <Field label="Discount">
                <div className="row gap-2">
                  <select value={discountType} onChange={(e) => setDiscountType(e.target.value as any)} style={{ width: 80 }} aria-label="Discount type">
                    <option value="amount">{currency}</option>
                    <option value="percent">%</option>
                  </select>
                  <input
                    type="number" min="0" step="10" value={discountValue}
                    onChange={(e) => setDiscountValue(Number(e.target.value))} style={{ textAlign: 'right' }}
                  />
                </div>
              </Field>
              <Field label="VAT rate (%)">
                <input type="number" min="0" max="100" step="1" value={vatRate} onChange={(e) => setVatRate(Number(e.target.value))} style={{ textAlign: 'right' }} />
              </Field>
            </div>

            <dl className="kv" style={{ gridTemplateColumns: '1fr auto' }}>
              <dt>Subtotal</dt><dd className="right">{money(totals.subtotal, currency, 2)}</dd>
              {totals.discount > 0 && <><dt>Discount</dt><dd className="right" style={{ color: 'var(--danger)' }}>−{money(totals.discount, currency, 2)}</dd></>}
              <dt>Net</dt><dd className="right">{money(totals.net, currency, 2)}</dd>
              <dt>VAT {vatRate}%</dt><dd className="right">{money(totals.vat, currency, 2)}</dd>
            </dl>
            <div className="row between mt-4" style={{ paddingTop: 10, borderTop: '2px solid var(--accent)' }}>
              <strong>Total</strong>
              <strong style={{ fontSize: 18 }}>{money(totals.total, currency, 2)}</strong>
            </div>
            {totals.optional > 0 && (
              <div className="row between mt-2 small muted">
                <span>Optional extras</span>
                <span>{money(totals.optional, currency, 2)}</span>
              </div>
            )}
            <div className="banner mt-4">
              <Icon name="dot" size={14} />
              <span className="tiny">
                Optional lines are priced separately and are never included in the headline total.
              </span>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
