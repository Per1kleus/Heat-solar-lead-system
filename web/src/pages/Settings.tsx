import { useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, patch, put, del } from '../lib/api';
import { useSession, useTheme } from '../lib/session';
import {
  Avatar, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorBlock, Field, Icon,
  LoadingBlock, Modal, Progress, useToast, type IconName,
} from '../components/ui';
import { money, date, dateTime, relative, label, number } from '../lib/format';

const SECTIONS: { path: string; label: string; icon: IconName; permission?: string }[] = [
  { path: 'company', label: 'Company', icon: 'settings', permission: 'settings:read' },
  { path: 'pipeline', label: 'Pipeline stages', icon: 'pipeline', permission: 'settings:read' },
  { path: 'sources', label: 'Lead sources', icon: 'target', permission: 'settings:read' },
  { path: 'scoring', label: 'Lead scoring', icon: 'analytics', permission: 'settings:read' },
  { path: 'assignment', label: 'Assignment rules', icon: 'user', permission: 'settings:read' },
  { path: 'templates', label: 'Message templates', icon: 'mail', permission: 'settings:read' },
  { path: 'communication', label: 'Communication', icon: 'whatsapp', permission: 'integrations:read' },
  { path: 'form', label: 'Website form & API', icon: 'link', permission: 'settings:read' },
  { path: 'users', label: 'Users & roles', icon: 'customers', permission: 'users:read' },
  { path: 'billing', label: 'Plan & billing', icon: 'euro', permission: 'billing:read' },
  { path: 'privacy', label: 'Privacy & data', icon: 'shield', permission: 'settings:read' },
  { path: 'audit', label: 'Audit log', icon: 'history', permission: 'audit:read' },
  { path: 'profile', label: 'My profile', icon: 'user' },
];

export default function Settings() {
  const { can } = useSession();
  const visible = SECTIONS.filter((s) => !s.permission || can(s.permission));

  return (
    <div className="page" style={{ maxWidth: 1240 }}>
      <div className="page-head"><div><h1>Settings</h1></div></div>
      <div className="grid" style={{ gridTemplateColumns: ' 210px minmax(0, 1fr)', gap: 20, alignItems: 'start' }}>
        <nav className="card" style={{ padding: 6, position: 'sticky', top: 70 }}>
          {visible.map((section) => (
            <NavLink
              key={section.path} to={`/app/settings/${section.path}`}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              <Icon name={section.icon} size={15} />
              <span className="truncate">{section.label}</span>
            </NavLink>
          ))}
        </nav>

        <div style={{ minWidth: 0 }}>
          <Routes>
            <Route index element={<Navigate to="company" replace />} />
            <Route path="company" element={<CompanySection />} />
            <Route path="pipeline" element={<PipelineSection />} />
            <Route path="sources" element={<SourcesSection />} />
            <Route path="scoring" element={<ScoringSection />} />
            <Route path="assignment" element={<AssignmentSection />} />
            <Route path="templates" element={<TemplatesSection />} />
            <Route path="communication" element={<CommunicationSection />} />
            <Route path="form" element={<FormSection />} />
            <Route path="users" element={<UsersSection />} />
            <Route path="billing" element={<BillingSection />} />
            <Route path="privacy" element={<PrivacySection />} />
            <Route path="audit" element={<AuditSection />} />
            <Route path="profile" element={<ProfileSection />} />
            <Route path="*" element={<Navigate to="company" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

// ---------- company ----------

function CompanySection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can, reload } = useSession();
  const [form, setForm] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const logoInput = useRef<HTMLInputElement>(null);

  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['company'], queryFn: () => get('/settings/company') });
  useEffect(() => { if (data?.company) setForm(data.company); }, [data]);

  if (isLoading || !form) return <LoadingBlock rows={4} height={60} />;
  if (error) return <ErrorBlock error={error} onRetry={refetch} />;

  const set = (key: string) => (e: any) => setForm((f: any) => ({ ...f, [key]: e.target.value }));

  const readLogo = (file: File) => {
    if (file.size > 300_000) return toast.show('Use an image under 300 KB.', 'error');
    const reader = new FileReader();
    reader.onload = () => setForm((f: any) => ({ ...f, logo_url: reader.result }));
    reader.readAsDataURL(file);
  };

  const save = async () => {
    setSaving(true);
    try {
      await patch('/settings/company', {
        name: form.name, logo_url: form.logo_url, address: form.address, city: form.city,
        postal_code: form.postal_code, country: form.country, phone: form.phone,
        email: form.email || null, website: form.website, vat_number: form.vat_number,
        tax_office: form.tax_office, registry_number: form.registry_number,
        currency: form.currency, vat_rate: Number(form.vat_rate), services: form.services,
        quote_prefix: form.quote_prefix, quote_validity_days: Number(form.quote_validity_days),
        quote_terms: form.quote_terms, quote_footer: form.quote_footer,
        stale_lead_hours: Number(form.stale_lead_hours),
      });
      queryClient.invalidateQueries({ queryKey: ['company'] });
      await reload();
      toast.success('Company details saved.');
    } catch (err) { toast.error(err); } finally { setSaving(false); }
  };

  const readOnly = !can('settings:write');

  return (
    <div className="col gap-6">
      <Card title="Company details" subtitle="These appear on every quotation you send.">
        <div className="row gap-6 wrap top mb-6">
          <div>
            {form.logo_url ? (
              <img src={form.logo_url} alt="Company logo" style={{ maxWidth: 160, maxHeight: 70, objectFit: 'contain', background: 'var(--surface-3)', borderRadius: 'var(--radius-sm)', padding: 6 }} />
            ) : (
              <div className="card center" style={{ width: 160, height: 70, display: 'grid', placeItems: 'center', color: 'var(--ink-3)' }}>No logo</div>
            )}
          </div>
          {!readOnly && (
            <div className="col gap-4">
              <input ref={logoInput} type="file" accept="image/png,image/jpeg,image/webp" style={{ display: 'none' }}
                onChange={(e) => e.target.files?.[0] && readLogo(e.target.files[0])} />
              <Button size="sm" icon="upload" onClick={() => logoInput.current?.click()}>Upload a logo</Button>
              {form.logo_url && <Button size="sm" variant="ghost" onClick={() => setForm((f: any) => ({ ...f, logo_url: null }))}>Remove</Button>}
              <span className="hint">PNG or JPEG, under 300 KB.</span>
            </div>
          )}
        </div>

        <div className="grid c2">
          <Field label="Company name"><input value={form.name ?? ''} onChange={set('name')} disabled={readOnly} /></Field>
          <Field label="Website"><input value={form.website ?? ''} onChange={set('website')} disabled={readOnly} /></Field>
          <Field label="Phone"><input value={form.phone ?? ''} onChange={set('phone')} disabled={readOnly} /></Field>
          <Field label="Email"><input type="email" value={form.email ?? ''} onChange={set('email')} disabled={readOnly} /></Field>
          <Field label="Address"><input value={form.address ?? ''} onChange={set('address')} disabled={readOnly} /></Field>
          <div className="grid c2">
            <Field label="Postal code"><input value={form.postal_code ?? ''} onChange={set('postal_code')} disabled={readOnly} /></Field>
            <Field label="City"><input value={form.city ?? ''} onChange={set('city')} disabled={readOnly} /></Field>
          </div>
          <Field label="VAT number"><input value={form.vat_number ?? ''} onChange={set('vat_number')} disabled={readOnly} /></Field>
          <Field label="Tax office"><input value={form.tax_office ?? ''} onChange={set('tax_office')} disabled={readOnly} /></Field>
        </div>
      </Card>

      <Card title="What you install" subtitle="Decides which technical questions appear on leads and on your website form.">
        <div className="chips">
          {[['pv', 'Photovoltaic'], ['heat_pump', 'Heat pumps'], ['battery', 'Batteries'], ['ev_charger', 'EV chargers']].map(([key, text]) => (
            <button
              key={key} type="button" disabled={readOnly}
              className={`chip ${(form.services ?? []).includes(key) ? 'on' : ''}`}
              onClick={() => setForm((f: any) => ({
                ...f,
                services: (f.services ?? []).includes(key)
                  ? f.services.filter((s: string) => s !== key)
                  : [...(f.services ?? []), key],
              }))}
            >
              {text}
            </button>
          ))}
        </div>
      </Card>

      <Card title="Quotation defaults">
        <div className="grid c3">
          <Field label="Number prefix"><input value={form.quote_prefix ?? 'Q'} onChange={set('quote_prefix')} disabled={readOnly} /></Field>
          <Field label="Validity (days)"><input type="number" min="1" max="365" value={form.quote_validity_days ?? 30} onChange={set('quote_validity_days')} disabled={readOnly} /></Field>
          <Field label="VAT rate (%)"><input type="number" min="0" max="100" value={form.vat_rate ?? 24} onChange={set('vat_rate')} disabled={readOnly} /></Field>
        </div>
        <Field label="Default terms and conditions">
          <textarea rows={7} value={form.quote_terms ?? ''} onChange={set('quote_terms')} disabled={readOnly} />
        </Field>
        <Field label="PDF footer line">
          <input value={form.quote_footer ?? ''} onChange={set('quote_footer')} disabled={readOnly} placeholder="Company registration, bank details…" />
        </Field>
      </Card>

      <Card title="Attention thresholds">
        <Field label="Flag a lead as gone quiet after (hours)" hint="Drives the “no activity” panel on the dashboard and the idle-lead automation.">
          <input type="number" min="1" max="720" value={form.stale_lead_hours ?? 48} onChange={set('stale_lead_hours')} disabled={readOnly} style={{ maxWidth: 140 }} />
        </Field>
      </Card>

      {!readOnly && (
        <div className="row end"><Button variant="primary" loading={saving} onClick={save}>Save company settings</Button></div>
      )}
    </div>
  );
}

// ---------- pipeline ----------

function PipelineSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<any>(null);

  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['stages-settings'], queryFn: () => get('/settings/stages') });
  if (isLoading) return <LoadingBlock rows={5} height={44} />;
  if (error) return <ErrorBlock error={error} onRetry={refetch} />;

  const update = async (id: string, patchBody: any) => {
    try {
      await patch(`/settings/stages/${id}`, patchBody);
      queryClient.invalidateQueries({ queryKey: ['stages-settings'] });
      queryClient.invalidateQueries({ queryKey: ['stages'] });
      queryClient.invalidateQueries({ queryKey: ['pipeline'] });
    } catch (err) { toast.error(err); }
  };

  const move = async (index: number, direction: number) => {
    const stages = [...data.stages];
    const target = index + direction;
    if (target < 0 || target >= stages.length) return;
    [stages[index], stages[target]] = [stages[target], stages[index]];
    try {
      await post('/settings/stages/reorder', { order: stages.map((s: any) => s.id) });
      queryClient.invalidateQueries({ queryKey: ['stages-settings'] });
    } catch (err) { toast.error(err); }
  };

  return (
    <div className="col gap-6">
      <Card
        title="Pipeline stages"
        subtitle="The probability on each stage drives your weighted pipeline and revenue forecast."
        actions={can('settings:write') ? <Button size="sm" icon="plus" onClick={() => setCreating(true)}>Add stage</Button> : undefined}
        padded={false}
      >
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th style={{ width: 70 }}>Order</th><th>Stage</th><th style={{ width: 130 }}>Probability</th><th style={{ width: 120 }}>Stale after</th><th style={{ width: 90 }}>Type</th><th style={{ width: 90 }}>Active</th><th style={{ width: 50 }} /></tr></thead>
            <tbody>
              {data.stages.map((stage: any, index: number) => (
                <tr key={stage.id} style={{ cursor: 'default' }}>
                  <td>
                    <div className="row gap-2">
                      <Button size="sm" variant="ghost" onClick={() => move(index, -1)} disabled={index === 0 || !can('settings:write')} aria-label="Move up">↑</Button>
                      <Button size="sm" variant="ghost" onClick={() => move(index, 1)} disabled={index === data.stages.length - 1 || !can('settings:write')} aria-label="Move down">↓</Button>
                    </div>
                  </td>
                  <td>
                    <div className="row gap-4">
                      <input
                        type="color" value={stage.color} style={{ width: 30, height: 26, padding: 1 }}
                        onChange={(e) => update(stage.id, { color: e.target.value })} disabled={!can('settings:write')}
                        aria-label={`Colour for ${stage.name}`}
                      />
                      <input
                        defaultValue={stage.name} onBlur={(e) => e.target.value !== stage.name && update(stage.id, { name: e.target.value })}
                        disabled={!can('settings:write')} aria-label="Stage name"
                      />
                    </div>
                  </td>
                  <td>
                    <input
                      type="number" min="0" max="100" defaultValue={stage.probability} style={{ textAlign: 'right' }}
                      onBlur={(e) => Number(e.target.value) !== stage.probability && update(stage.id, { probability: Number(e.target.value) })}
                      disabled={!can('settings:write') || stage.type !== 'open'} aria-label="Probability"
                    />
                  </td>
                  <td>
                    <input
                      type="number" min="0" max="365" defaultValue={stage.stale_days} style={{ textAlign: 'right' }}
                      onBlur={(e) => Number(e.target.value) !== stage.stale_days && update(stage.id, { stale_days: Number(e.target.value) })}
                      disabled={!can('settings:write') || stage.type !== 'open'} aria-label="Stale after days"
                    />
                  </td>
                  <td><Badge tone={stage.type === 'won' ? 'good' : stage.type === 'lost' ? 'danger' : ''}>{stage.type}</Badge></td>
                  <td>
                    <input
                      type="checkbox" checked={!!stage.is_active} disabled={!can('settings:write')}
                      onChange={(e) => update(stage.id, { is_active: e.target.checked })} aria-label="Active"
                    />
                  </td>
                  <td>
                    {can('settings:write') && stage.type === 'open' && (
                      <Button size="sm" variant="ghost" icon="trash" onClick={() => setDeleting(stage)} aria-label="Delete stage" />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {creating && (
        <StageDialog
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); queryClient.invalidateQueries({ queryKey: ['stages-settings'] }); toast.success('Stage added.'); }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title={`Remove “${deleting.name}”?`} tone="danger" confirmLabel="Remove"
          message="If leads are sitting in this stage it is hidden rather than deleted, so nothing is orphaned."
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            try {
              const result = await del(`/settings/stages/${deleting.id}`);
              setDeleting(null);
              queryClient.invalidateQueries({ queryKey: ['stages-settings'] });
              toast.success(result.message ?? 'Stage removed.');
            } catch (err) { toast.error(err); }
          }}
        />
      )}
    </div>
  );
}

function StageDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [probability, setProbability] = useState(30);
  const [color, setColor] = useState('#14b8a6');
  const [staleDays, setStaleDays] = useState(7);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  return (
    <Modal
      title="New pipeline stage" onClose={onClose} width="narrow"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary" loading={saving} disabled={!name.trim()}
            onClick={async () => {
              setSaving(true);
              try {
                await post('/settings/stages', { name, probability, color, stale_days: staleDays, type: 'open' });
                onSaved();
              } catch (err) { toast.error(err); } finally { setSaving(false); }
            }}
          >
            Add stage
          </Button>
        </>
      }
    >
      <div className="col gap-6">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Design approval" /></Field>
        <div className="grid c3">
          <Field label="Probability (%)"><input type="number" min="0" max="100" value={probability} onChange={(e) => setProbability(Number(e.target.value))} /></Field>
          <Field label="Stale after (days)"><input type="number" min="0" value={staleDays} onChange={(e) => setStaleDays(Number(e.target.value))} /></Field>
          <Field label="Colour"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ height: 34 }} /></Field>
        </div>
      </div>
    </Modal>
  );
}

// ---------- sources & lost reasons ----------

function SourcesSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const [newSource, setNewSource] = useState('');
  const [newReason, setNewReason] = useState('');

  const sources = useQuery({ queryKey: ['sources-settings'], queryFn: () => get('/settings/sources') });
  const reasons = useQuery({ queryKey: ['lost-reasons'], queryFn: () => get('/settings/lost-reasons') });

  const addSource = async () => {
    try {
      await post('/settings/sources', { name: newSource, category: 'other' });
      setNewSource('');
      queryClient.invalidateQueries({ queryKey: ['sources-settings'] });
      toast.success('Source added.');
    } catch (err) { toast.error(err); }
  };

  const addReason = async () => {
    try {
      await post('/settings/lost-reasons', { name: newReason, recoverable: true });
      setNewReason('');
      queryClient.invalidateQueries({ queryKey: ['lost-reasons'] });
      toast.success('Reason added.');
    } catch (err) { toast.error(err); }
  };

  return (
    <div className="col gap-6">
      <Card title="Lead sources" subtitle="Every lead carries one. This is what makes the marketing analytics work." padded={false}>
        {sources.isLoading ? <div style={{ padding: 14 }}><LoadingBlock rows={4} height={34} /></div> : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Source</th><th>Type</th><th className="num">Monthly cost</th><th style={{ width: 80 }}>Active</th></tr></thead>
              <tbody>
                {(sources.data?.sources ?? []).map((source: any) => (
                  <tr key={source.id} style={{ cursor: 'default' }}>
                    <td className="strong">{source.name}{source.is_system ? <span className="tiny dim"> · built in</span> : ''}</td>
                    <td>
                      <select
                        defaultValue={source.category} disabled={!can('settings:write')} style={{ width: 'auto' }}
                        onChange={async (e) => {
                          await patch(`/settings/sources/${source.id}`, { category: e.target.value });
                          queryClient.invalidateQueries({ queryKey: ['sources-settings'] });
                        }}
                        aria-label="Category"
                      >
                        {['paid', 'organic', 'referral', 'direct', 'other'].map((c) => <option key={c} value={c}>{label(c)}</option>)}
                      </select>
                    </td>
                    <td className="num">
                      <input
                        type="number" min="0" step="50" defaultValue={source.cost_per_month} disabled={!can('settings:write')}
                        style={{ textAlign: 'right', maxWidth: 110 }}
                        onBlur={async (e) => {
                          if (Number(e.target.value) === source.cost_per_month) return;
                          await patch(`/settings/sources/${source.id}`, { cost_per_month: Number(e.target.value) });
                          queryClient.invalidateQueries({ queryKey: ['sources-settings'] });
                        }}
                        aria-label="Monthly cost"
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox" checked={!!source.is_active} disabled={!can('settings:write')}
                        onChange={async (e) => {
                          await patch(`/settings/sources/${source.id}`, { is_active: e.target.checked });
                          queryClient.invalidateQueries({ queryKey: ['sources-settings'] });
                        }}
                        aria-label="Active"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {can('settings:write') && (
          <div className="card-foot row gap-4">
            <input value={newSource} onChange={(e) => setNewSource(e.target.value)} placeholder="Add a source (e.g. Trade fair)" />
            <Button onClick={addSource} disabled={!newSource.trim()}>Add</Button>
          </div>
        )}
      </Card>

      <Card title="Lost reasons" subtitle="Recorded every time a lead is lost, so you can see where the pipeline leaks." padded={false}>
        {reasons.isLoading ? <div style={{ padding: 14 }}><LoadingBlock rows={3} height={34} /></div> : (
          <div>
            {(reasons.data?.lost_reasons ?? []).map((reason: any) => (
              <div key={reason.id} className="attention-item" style={{ cursor: 'default' }}>
                <span className="grow strong">{reason.name}</span>
                {reason.recoverable ? <Badge tone="accent">offers a recovery date</Badge> : <Badge>final</Badge>}
                {can('settings:write') && (
                  <Button
                    size="sm" variant="ghost" icon="trash" aria-label="Remove"
                    onClick={async () => {
                      await del(`/settings/lost-reasons/${reason.id}`);
                      queryClient.invalidateQueries({ queryKey: ['lost-reasons'] });
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        )}
        {can('settings:write') && (
          <div className="card-foot row gap-4">
            <input value={newReason} onChange={(e) => setNewReason(e.target.value)} placeholder="Add a reason" />
            <Button onClick={addReason} disabled={!newReason.trim()}>Add</Button>
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------- scoring ----------

function ScoringSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['scoring'], queryFn: () => get('/settings/scoring') });

  if (isLoading) return <LoadingBlock rows={6} height={40} />;
  if (error) return <ErrorBlock error={error} onRetry={refetch} />;

  const update = async (id: string, body: any) => {
    try {
      await patch(`/settings/scoring/${id}`, body);
      queryClient.invalidateQueries({ queryKey: ['scoring'] });
      toast.success('Scoring updated. New scores apply the next time a lead changes.');
    } catch (err) { toast.error(err); }
  };

  return (
    <div className="col gap-6">
      <Card title="How a lead earns its score" subtitle="Nothing here is a black box — the lead page shows which of these fired.">
        <div className="row gap-6 wrap mb-6">
          <Badge tone="hot">🔥 Hot — {data.bands.hot} and above</Badge>
          <Badge tone="warm">🟡 Warm — {data.bands.warm} to {data.bands.hot - 1}</Badge>
          <Badge tone="cold">🔵 Cold — below {data.bands.warm}</Badge>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Factor</th><th style={{ width: 110 }} className="num">Points</th><th style={{ width: 150 }}>Threshold</th><th style={{ width: 80 }}>Active</th></tr></thead>
            <tbody>
              {data.rules.map((rule: any) => (
                <tr key={rule.id} style={{ cursor: 'default' }}>
                  <td>
                    <div className="strong">{rule.label}</div>
                    <div className="tiny dim mono">{rule.key}</div>
                  </td>
                  <td className="num">
                    <input
                      type="number" min="-50" max="50" defaultValue={rule.points} style={{ textAlign: 'right' }}
                      disabled={!can('settings:write')}
                      onBlur={(e) => Number(e.target.value) !== rule.points && update(rule.id, { points: Number(e.target.value) })}
                      aria-label={`Points for ${rule.label}`}
                    />
                  </td>
                  <td>
                    {Object.keys(rule.config).length === 0 ? <span className="dim small">—</span> : (
                      Object.entries(rule.config).map(([key, value]) => (
                        Array.isArray(value) ? (
                          <span key={key} className="tiny dim">{value.join(', ')}</span>
                        ) : (
                          <input
                            key={key} type="number" defaultValue={value as number} style={{ textAlign: 'right' }}
                            disabled={!can('settings:write')}
                            onBlur={(e) => Number(e.target.value) !== value && update(rule.id, { config: { ...rule.config, [key]: Number(e.target.value) } })}
                            aria-label={`${key} for ${rule.label}`}
                          />
                        )
                      ))
                    )}
                  </td>
                  <td>
                    <input
                      type="checkbox" checked={rule.is_active} disabled={!can('settings:write')}
                      onChange={(e) => update(rule.id, { is_active: e.target.checked })} aria-label="Active"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ---------- assignment ----------

function AssignmentSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const [creating, setCreating] = useState(false);

  const rules = useQuery({ queryKey: ['assignment'], queryFn: () => get('/settings/assignment') });
  const users = useQuery({ queryKey: ['users-light'], queryFn: () => get('/settings/users') });

  return (
    <div className="col gap-6">
      <Card
        title="Assignment rules"
        subtitle="Applied top to bottom when a lead arrives. The first rule whose conditions match wins."
        actions={can('settings:write') ? <Button size="sm" icon="plus" onClick={() => setCreating(true)}>Add rule</Button> : undefined}
        padded={false}
      >
        {rules.isLoading ? <div style={{ padding: 14 }}><LoadingBlock rows={3} height={40} /></div>
          : (rules.data?.rules ?? []).length === 0 ? (
            <EmptyState icon="user" title="No rules" message="Without a rule, new leads are shared round-robin across your sales team." />
          ) : (
            <div>
              {rules.data.rules.map((rule: any) => (
                <div key={rule.id} className="attention-item" style={{ cursor: 'default' }}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="strong">{rule.name}</div>
                    <div className="tiny dim">
                      {rule.strategy === 'specific_user'
                        ? `Always to ${(users.data?.users ?? []).find((u: any) => u.id === rule.target_user_id)?.full_name ?? 'a removed user'}`
                        : rule.strategy === 'least_open' ? 'To whoever has the fewest open leads'
                          : rule.strategy === 'unassigned' ? 'Leave unassigned for a manager to allocate'
                            : 'Round-robin across the sales team'}
                      {rule.conditions.length > 0 && ` · when ${rule.conditions.map((c: any) => `${c.field} ${c.op} ${c.value}`).join(' and ')}`}
                    </div>
                  </div>
                  {!rule.is_active && <Badge>off</Badge>}
                  {can('settings:write') && (
                    <Button
                      size="sm" variant="ghost" icon="trash" aria-label="Delete"
                      onClick={async () => {
                        await del(`/settings/assignment/${rule.id}`);
                        queryClient.invalidateQueries({ queryKey: ['assignment'] });
                        toast.success('Rule removed.');
                      }}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
      </Card>

      {creating && (
        <AssignmentDialog
          users={users.data?.users ?? []}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); queryClient.invalidateQueries({ queryKey: ['assignment'] }); toast.success('Rule added.'); }}
        />
      )}
    </div>
  );
}

const CONDITION_FIELDS = [
  { key: 'project_types', label: 'Product interest', ops: ['contains'] },
  { key: 'city', label: 'City', ops: ['eq', 'contains'] },
  { key: 'estimated_value', label: 'Estimated value', ops: ['gte', 'lte'] },
  { key: 'source_key', label: 'Source', ops: ['eq'] },
  { key: 'urgency', label: 'Urgency', ops: ['eq'] },
];

function AssignmentDialog({ users, onClose, onSaved }: { users: any[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('');
  const [strategy, setStrategy] = useState('round_robin');
  const [targetUser, setTargetUser] = useState('');
  const [conditions, setConditions] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  return (
    <Modal
      title="New assignment rule" onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary" loading={saving} disabled={!name.trim()}
            onClick={async () => {
              setSaving(true);
              try {
                await post('/settings/assignment', {
                  name, strategy, target_user_id: targetUser || undefined,
                  conditions: conditions.filter((c) => c.field && c.value !== ''),
                });
                onSaved();
              } catch (err) { toast.error(err); } finally { setSaving(false); }
            }}
          >
            Add rule
          </Button>
        </>
      }
    >
      <div className="col gap-6">
        <Field label="Name"><input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="Heat pumps go to Katerina" /></Field>
        <Field label="Assign to">
          <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
            <option value="round_robin">Round-robin across the sales team</option>
            <option value="least_open">Whoever has the fewest open leads</option>
            <option value="specific_user">A specific person</option>
            <option value="unassigned">Leave unassigned</option>
          </select>
        </Field>
        {strategy === 'specific_user' && (
          <Field label="Person">
            <select value={targetUser} onChange={(e) => setTargetUser(e.target.value)}>
              <option value="">Choose…</option>
              {users.filter((u: any) => u.status === 'active' && u.role !== 'technician').map((u: any) => (
                <option key={u.id} value={u.id}>{u.full_name}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label="Only when" hint="Leave empty to apply to every new lead.">
          <div className="col gap-4">
            {conditions.map((condition, index) => {
              const field = CONDITION_FIELDS.find((f) => f.key === condition.field);
              return (
                <div key={index} className="row gap-4">
                  <select
                    value={condition.field}
                    onChange={(e) => setConditions((c) => c.map((x, i) => (i === index ? { ...x, field: e.target.value, op: CONDITION_FIELDS.find((f) => f.key === e.target.value)!.ops[0] } : x)))}
                    aria-label="Field"
                  >
                    {CONDITION_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                  </select>
                  <select
                    value={condition.op}
                    onChange={(e) => setConditions((c) => c.map((x, i) => (i === index ? { ...x, op: e.target.value } : x)))}
                    style={{ width: 110 }} aria-label="Operator"
                  >
                    {(field?.ops ?? ['eq']).map((op) => (
                      <option key={op} value={op}>
                        {({ eq: 'is', contains: 'contains', gte: 'at least', lte: 'at most' } as any)[op]}
                      </option>
                    ))}
                  </select>
                  <input
                    value={condition.value}
                    onChange={(e) => setConditions((c) => c.map((x, i) => (i === index ? { ...x, value: e.target.value } : x)))}
                    placeholder={condition.field === 'project_types' ? 'heat_pump' : ''}
                    aria-label="Value"
                  />
                  <Button size="sm" variant="ghost" icon="trash" aria-label="Remove condition" onClick={() => setConditions((c) => c.filter((_, i) => i !== index))} />
                </div>
              );
            })}
            <Button size="sm" icon="plus" onClick={() => setConditions((c) => [...c, { field: 'project_types', op: 'contains', value: '' }])}>
              Add condition
            </Button>
          </div>
        </Field>
      </div>
    </Modal>
  );
}

// ---------- templates ----------

function TemplatesSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const [editing, setEditing] = useState<any>(null);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['templates'], queryFn: () => get('/settings/templates') });

  if (isLoading) return <LoadingBlock rows={4} height={50} />;
  if (error) return <ErrorBlock error={error} onRetry={refetch} />;

  return (
    <div className="col gap-6">
      <div className="banner">
        <Icon name="shield" size={16} />
        <span>
          Operational templates are about the customer's own enquiry and may always be sent.
          A template marked as marketing is only sent to contacts who have given consent.
        </span>
      </div>
      <Card title="Message templates" padded={false}>
        {data.templates.map((template: any) => (
          <div key={template.id} className="attention-item" style={{ cursor: 'default' }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row gap-4">
                <span className="strong">{template.name}</span>
                <Badge outline>{template.channel}</Badge>
                <Badge tone={template.purpose === 'marketing' ? 'warm' : 'accent'}>{template.purpose}</Badge>
                {!template.is_active && <Badge>off</Badge>}
              </div>
              {template.subject && <div className="tiny dim truncate">{template.subject}</div>}
            </div>
            {can('settings:write') && <Button size="sm" icon="edit" onClick={() => setEditing(template)} aria-label="Edit template" />}
          </div>
        ))}
      </Card>

      {editing && (
        <TemplateDialog
          template={editing} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); queryClient.invalidateQueries({ queryKey: ['templates'] }); toast.success('Template saved.'); }}
        />
      )}
    </div>
  );
}

function TemplateDialog({ template, onClose, onSaved }: { template: any; onClose: () => void; onSaved: () => void }) {
  const [subject, setSubject] = useState(template.subject ?? '');
  const [body, setBody] = useState(template.body);
  const [active, setActive] = useState(!!template.is_active);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  return (
    <Modal
      title={template.name} subtitle="Placeholders: {{lead.first_name}}, {{lead.project_summary}}, {{quote.number}}, {{quote.total}}, {{company.name}}, {{user.first_name}}"
      onClose={onClose} width="wide"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary" loading={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await patch(`/settings/templates/${template.id}`, { subject: subject || null, body, is_active: active });
                onSaved();
              } catch (err) { toast.error(err); } finally { setSaving(false); }
            }}
          >
            Save template
          </Button>
        </>
      }
    >
      <div className="col gap-6">
        {template.channel === 'email' && (
          <Field label="Subject"><input value={subject} onChange={(e) => setSubject(e.target.value)} /></Field>
        )}
        <Field label="Message"><textarea rows={14} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          <span>Template is active</span>
        </label>
      </div>
    </Modal>
  );
}

// ---------- communication ----------

const PROVIDER_FIELDS: Record<string, { config: { key: string; label: string; type?: string; hint?: string }[]; secrets: { key: string; label: string }[]; blurb: string }> = {
  smtp: {
    blurb: 'Connect the mailbox you already use. VoltaFlow verifies the connection before it saves — nothing is marked as connected unless the server answers.',
    config: [
      { key: 'host', label: 'SMTP host', hint: 'e.g. smtp.gmail.com' },
      { key: 'port', label: 'Port', type: 'number' },
      { key: 'from_address', label: 'Send from address' },
      { key: 'from_name', label: 'Send from name' },
    ],
    secrets: [{ key: 'user', label: 'Username' }, { key: 'pass', label: 'Password or app password' }],
  },
  whatsapp_cloud: {
    blurb: 'WhatsApp Business Cloud API. You need a phone number id and a permanent access token from Meta.',
    config: [{ key: 'phone_number_id', label: 'Phone number id' }, { key: 'business_account_id', label: 'Business account id' }],
    secrets: [{ key: 'access_token', label: 'Access token' }],
  },
  anthropic: {
    blurb: 'Powers the optional AI summaries, suggested next actions and draft replies. Drafts are always grounded in the lead record.',
    config: [{ key: 'model', label: 'Model', hint: 'Leave blank for the default.' }],
    secrets: [{ key: 'api_key', label: 'API key' }],
  },
  meta_lead_ads: {
    blurb: 'Meta Lead Ads. The intake endpoint and lead mapping are ready — add your page token when you are set up on Meta.',
    config: [{ key: 'page_id', label: 'Page id' }, { key: 'form_id', label: 'Lead form id' }],
    secrets: [{ key: 'access_token', label: 'Page access token' }],
  },
  google_ads: {
    blurb: 'Google Ads lead form extensions post straight into the intake API. Store your webhook key here.',
    config: [{ key: 'customer_id', label: 'Customer id' }],
    secrets: [{ key: 'webhook_key', label: 'Webhook key' }],
  },
  telephony: {
    blurb: 'Optional. Click-to-call already works from any device; a telephony provider adds automatic call logging.',
    config: [{ key: 'provider', label: 'Provider' }, { key: 'account', label: 'Account id' }],
    secrets: [{ key: 'api_key', label: 'API key' }],
  },
};

function CommunicationSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can, reload } = useSession();
  const [editing, setEditing] = useState<any>(null);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['integrations'], queryFn: () => get('/settings/integrations') });

  if (isLoading) return <LoadingBlock rows={4} height={60} />;
  if (error) return <ErrorBlock error={error} onRetry={refetch} />;

  return (
    <div className="col gap-6">
      <div className="banner">
        <Icon name="shield" size={16} />
        <span>
          Keys and passwords are stored on the server and never sent back to the browser.
          Until a channel is connected, VoltaFlow refuses to send through it rather than pretending it did.
        </span>
      </div>

      {data.integrations.map((integration: any) => (
        <Card
          key={integration.provider}
          title={
            <h2 className="row gap-4">
              {integration.label}
              <Badge tone={integration.status === 'connected' ? 'good' : integration.status === 'error' ? 'danger' : ''}>
                {integration.status === 'connected' ? 'Connected' : integration.status === 'error' ? 'Error' : 'Not connected'}
              </Badge>
            </h2>
          }
          subtitle={PROVIDER_FIELDS[integration.provider]?.blurb}
          actions={can('integrations:write') ? <Button size="sm" onClick={() => setEditing(integration)}>Configure</Button> : undefined}
        >
          {integration.last_error && (
            <div className="banner error"><Icon name="alert" size={15} /><span>{integration.last_error}</span></div>
          )}
          {integration.status === 'connected' && (
            <div className="small muted">
              Checked {relative(integration.last_checked_at)}.
              {Object.entries(integration.config).filter(([, v]) => v).slice(0, 3).map(([key, value]) => (
                <span key={key}> · {key.replace(/_/g, ' ')}: {String(value)}</span>
              ))}
            </div>
          )}
        </Card>
      ))}

      {editing && (
        <IntegrationDialog
          integration={editing} onClose={() => setEditing(null)}
          onSaved={async (message) => {
            setEditing(null);
            queryClient.invalidateQueries({ queryKey: ['integrations'] });
            await reload();
            toast.success(message);
          }}
        />
      )}
    </div>
  );
}

function IntegrationDialog({
  integration, onClose, onSaved,
}: { integration: any; onClose: () => void; onSaved: (message: string) => void }) {
  const spec = PROVIDER_FIELDS[integration.provider];
  const [config, setConfig] = useState<Record<string, any>>(integration.config ?? {});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (enabled: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const result = await put(`/settings/integrations/${integration.provider}`, {
        config, secrets: Object.keys(secrets).length ? secrets : undefined, enabled,
      });
      onSaved(result.message);
    } catch (err: any) {
      setError(err?.message ?? 'Could not save the connection.');
    } finally { setSaving(false); }
  };

  return (
    <Modal
      title={integration.label} subtitle={spec?.blurb} onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          {integration.status !== 'disconnected' && (
            <Button onClick={() => submit(false)} disabled={saving}>Disconnect</Button>
          )}
          <Button variant="primary" loading={saving} onClick={() => submit(true)}>Save &amp; connect</Button>
        </>
      }
    >
      <div className="col gap-6">
        {error && <div className="banner error" role="alert"><Icon name="alert" size={15} /><span>{error}</span></div>}
        {spec?.config.map((field) => (
          <Field key={field.key} label={field.label} hint={field.hint}>
            <input
              type={field.type ?? 'text'} value={config[field.key] ?? ''}
              onChange={(e) => setConfig((c) => ({ ...c, [field.key]: e.target.value }))}
            />
          </Field>
        ))}
        {spec?.secrets.map((field) => (
          <Field
            key={field.key} label={field.label}
            hint={integration.has_secrets ? 'Stored. Leave blank to keep the current value.' : undefined}
          >
            <input
              type="password" autoComplete="new-password" value={secrets[field.key] ?? ''}
              onChange={(e) => setSecrets((s) => ({ ...s, [field.key]: e.target.value }))}
              placeholder={integration.has_secrets ? '••••••••' : ''}
            />
          </Field>
        ))}
      </div>
    </Modal>
  );
}

// ---------- website form & API ----------

function FormSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can } = useSession();
  const [apiKey, setApiKey] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['company'], queryFn: () => get('/settings/company') });

  if (isLoading) return <LoadingBlock rows={3} height={70} />;
  if (error) return <ErrorBlock error={error} onRetry={refetch} />;

  const formUrl = `${window.location.origin}/f/${data.company.public_form_token}`;
  const snippet = `<div id="voltaflow-form"></div>\n<script src="${window.location.origin}/embed.js" data-voltaflow-token="${data.company.public_form_token}" defer></script>`;

  const copy = (text: string, what: string) => {
    navigator.clipboard?.writeText(text);
    toast.success(`${what} copied.`);
  };

  return (
    <div className="col gap-6">
      <Card title="Your website form" subtitle="Paste this on your website. Enquiries land in the pipeline immediately, assigned and scored.">
        <Field label="Embed snippet">
          <textarea readOnly rows={3} value={snippet} className="mono" style={{ fontSize: 12 }} onFocus={(e) => e.target.select()} />
        </Field>
        <div className="row gap-4 wrap mt-4">
          <Button icon="link" onClick={() => copy(snippet, 'Snippet')}>Copy snippet</Button>
          <a className="btn" href={formUrl} target="_blank" rel="noreferrer"><Icon name="doc" size={15} />Preview the form</a>
          <Button onClick={() => copy(formUrl, 'Form link')}>Copy the direct link</Button>
          {can('settings:write') && (
            <Button
              variant="ghost"
              onClick={async () => {
                await post('/settings/form-token');
                queryClient.invalidateQueries({ queryKey: ['company'] });
                toast.success('A new form link was generated. Update the snippet on your website.');
              }}
            >
              Regenerate link
            </Button>
          )}
        </div>
      </Card>

      <Card title="Intake API" subtitle="For landing pages, Make.com, Zapier, Google and Meta lead forms.">
        {apiKey ? (
          <div className="banner success">
            <Icon name="check" size={15} />
            <div className="grow">
              <strong>Your new API key — copy it now, it is not shown again.</strong>
              <div className="mono mt-2" style={{ wordBreak: 'break-all' }}>{apiKey}</div>
            </div>
            <Button size="sm" onClick={() => copy(apiKey, 'API key')}>Copy</Button>
          </div>
        ) : (
          <p className="small muted">
            {data.company.api_key_hint
              ? <>Current key: <span className="mono">{data.company.api_key_hint}</span></>
              : 'No API key yet.'}
          </p>
        )}
        {can('integrations:write') && (
          <Button
            className="mt-4"
            onClick={async () => {
              const result = await post('/settings/api-key');
              setApiKey(result.api_key);
              queryClient.invalidateQueries({ queryKey: ['company'] });
            }}
          >
            {data.company.api_key_hint ? 'Generate a new key' : 'Generate an API key'}
          </Button>
        )}

        <div className="mt-6">
          <h3 className="mb-2">How to post a lead</h3>
          <pre className="card mono" style={{ padding: 12, overflowX: 'auto', fontSize: 12, margin: 0 }}>
{`POST ${window.location.origin}/api/public/intake
X-API-Key: <your key>
Idempotency-Key: <unique id per submission>
Content-Type: application/json

{
  "first_name": "Giorgos",
  "last_name": "Papadopoulos",
  "phone": "+30 694 512 3388",
  "email": "g.papadopoulos@example.gr",
  "city": "Thessaloniki",
  "source": "google_ads",
  "campaign": "pv-autumn",
  "project_types": ["pv", "battery"],
  "estimated_value": 14000,
  "fields": { "pv_annual_kwh": 12400, "pv_roof_type": "tile" }
}`}
          </pre>
          <p className="small muted mt-2" style={{ marginBottom: 0 }}>
            The response contains the new lead id, its owner and its score, plus any duplicates it matched.
            Retrying with the same Idempotency-Key never creates a second lead.
          </p>
        </div>
      </Card>
    </div>
  );
}

// ---------- users ----------

function UsersSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can, user: me } = useSession();
  const [inviting, setInviting] = useState(false);
  const [invite, setInvite] = useState<any>(null);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['users-settings'], queryFn: () => get('/settings/users') });

  if (isLoading) return <LoadingBlock rows={4} height={50} />;
  if (error) return <ErrorBlock error={error} onRetry={refetch} />;

  const seatsLeft = data.subscription.seats - data.subscription.usage.seats_used;

  return (
    <div className="col gap-6">
      <Card
        title="Users"
        subtitle={`${data.subscription.usage.seats_used} of ${data.subscription.seats} seats used on the ${data.subscription.plan} plan`}
        actions={can('users:write') ? <Button size="sm" icon="plus" onClick={() => setInviting(true)} disabled={seatsLeft <= 0}>Add user</Button> : undefined}
        padded={false}
      >
        {seatsLeft <= 0 && (
          <div style={{ padding: '10px 14px' }}>
            <div className="banner warn">
              <Icon name="alert" size={15} />
              <span>All seats are in use. Upgrade your plan to add more of your team.</span>
            </div>
          </div>
        )}
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>User</th><th>Role</th><th className="num hide-mobile">Open leads</th><th className="num hide-mobile">Open tasks</th><th className="hide-mobile">Last seen</th><th>Status</th></tr></thead>
            <tbody>
              {data.users.map((user: any) => (
                <tr key={user.id} style={{ cursor: 'default' }}>
                  <td>
                    <div className="row gap-4">
                      <Avatar name={user.full_name} color={user.avatar_color} size="sm" />
                      <div>
                        <div className="strong">{user.full_name}{user.id === me?.id ? ' (you)' : ''}</div>
                        <div className="tiny dim">{user.email}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <select
                      defaultValue={user.role} disabled={!can('users:write')} style={{ width: 'auto' }}
                      onChange={async (e) => {
                        try {
                          await patch(`/settings/users/${user.id}`, { role: e.target.value });
                          queryClient.invalidateQueries({ queryKey: ['users-settings'] });
                          toast.success('Role updated.');
                        } catch (err) { toast.error(err); refetch(); }
                      }}
                      aria-label={`Role for ${user.full_name}`}
                    >
                      {data.roles.map((role: any) => <option key={role.key} value={role.key}>{role.label}</option>)}
                    </select>
                  </td>
                  <td className="num hide-mobile">{number(user.open_leads)}</td>
                  <td className="num hide-mobile">{number(user.open_tasks)}</td>
                  <td className="hide-mobile small dim">{user.last_login_at ? relative(user.last_login_at) : 'never'}</td>
                  <td>
                    {user.status === 'active' ? <Badge tone="good">Active</Badge>
                      : user.status === 'invited' ? <Badge tone="warm">Invited</Badge>
                        : <Badge tone="danger">Disabled</Badge>}
                    {can('users:write') && user.id !== me?.id && (
                      <Button
                        size="sm" variant="ghost" className="mt-2"
                        onClick={async () => {
                          try {
                            await patch(`/settings/users/${user.id}`, { status: user.status === 'disabled' ? 'active' : 'disabled' });
                            queryClient.invalidateQueries({ queryKey: ['users-settings'] });
                            toast.success(user.status === 'disabled' ? 'User re-enabled.' : 'User disabled — their sessions were ended.');
                          } catch (err) { toast.error(err); }
                        }}
                      >
                        {user.status === 'disabled' ? 'Enable' : 'Disable'}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card title="What each role can do">
        <div className="col gap-6">
          {data.roles.map((role: any) => (
            <div key={role.key}>
              <div className="strong">{role.label}</div>
              <div className="small muted">{ROLE_BLURBS[role.key]}</div>
            </div>
          ))}
        </div>
      </Card>

      {inviting && (
        <InviteDialog
          roles={data.roles}
          onClose={() => setInviting(false)}
          onSaved={(result) => {
            setInviting(false);
            setInvite(result);
            queryClient.invalidateQueries({ queryKey: ['users-settings'] });
          }}
        />
      )}
      {invite && (
        <Modal title="User added" onClose={() => setInvite(null)} width="narrow"
          footer={<Button variant="primary" onClick={() => setInvite(null)}>Done</Button>}>
          {invite.invite_link ? (
            <>
              <p className="small muted">
                {invite.email_connected
                  ? 'Send this invitation link to your colleague — they choose their own password.'
                  : 'Email is not connected, so share this invitation link with your colleague directly.'}
              </p>
              <div className="card mono" style={{ padding: 10, wordBreak: 'break-all', fontSize: 12 }}>
                {window.location.origin}{invite.invite_link}
              </div>
              <Button
                className="mt-4"
                onClick={() => { navigator.clipboard?.writeText(`${window.location.origin}${invite.invite_link}`); toast.success('Link copied.'); }}
              >
                Copy invitation link
              </Button>
            </>
          ) : (
            <p className="small muted">The account is active and they can sign in with the password you set.</p>
          )}
        </Modal>
      )}
    </div>
  );
}

const ROLE_BLURBS: Record<string, string> = {
  owner: 'Everything, including billing and ownership of the account.',
  admin: 'Everything except account ownership — users, settings, integrations, automation and all data.',
  sales_manager: 'Sees every lead and quotation, assigns work, monitors the team and edits automation. Cannot change users or billing.',
  salesperson: 'Their own leads, quotations, tasks and appointments. Cannot see other salespeople’s pipelines.',
  technician: 'Site surveys, appointments, installation jobs, photos and technical notes. No pricing or pipeline access.',
};

function InviteDialog({ roles, onClose, onSaved }: { roles: any[]; onClose: () => void; onSaved: (result: any) => void }) {
  const [form, setForm] = useState({ first_name: '', last_name: '', email: '', role: 'salesperson', password: '' });
  const [setPassword, setSetPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const toast = useToast();
  const set = (key: string) => (e: any) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <Modal
      title="Add a user" onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary" loading={saving} disabled={!form.email.trim() || !form.first_name.trim()}
            onClick={async () => {
              setSaving(true);
              try {
                const result = await post('/settings/users', {
                  ...form, password: setPassword && form.password ? form.password : undefined,
                });
                onSaved(result);
              } catch (err) { toast.error(err); } finally { setSaving(false); }
            }}
          >
            Add user
          </Button>
        </>
      }
    >
      <div className="col gap-6">
        <div className="grid c2">
          <Field label="First name" required><input value={form.first_name} onChange={set('first_name')} autoFocus /></Field>
          <Field label="Last name"><input value={form.last_name} onChange={set('last_name')} /></Field>
        </div>
        <Field label="Work email" required><input type="email" value={form.email} onChange={set('email')} /></Field>
        <Field label="Role">
          <select value={form.role} onChange={set('role')}>
            {roles.filter((r: any) => r.key !== 'owner').map((role: any) => <option key={role.key} value={role.key}>{role.label}</option>)}
          </select>
          <span className="hint">{ROLE_BLURBS[form.role]}</span>
        </Field>
        <label className="check">
          <input type="checkbox" checked={setPassword} onChange={(e) => setSetPassword(e.target.checked)} />
          <span>Set their password myself (otherwise they get an invitation link)</span>
        </label>
        {setPassword && (
          <Field label="Password" hint="At least 10 characters.">
            <input type="password" value={form.password} onChange={set('password')} minLength={10} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

// ---------- billing ----------

const PLAN_FEATURES: Record<string, string[]> = {
  starter: ['2 users', '250 leads a month', 'Pipeline, scoring and quotations', 'Core follow-up automation'],
  growth: ['5 users', '1,000 leads a month', 'Custom automation builder', 'Full analytics and attribution', 'Site surveys', 'Email and WhatsApp integrations'],
  pro: ['15 users', 'Large lead allowance', 'AI summaries and suggested replies', 'Advanced revenue analytics', 'Open API and webhooks'],
};

function BillingSection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can, reload } = useSession();
  const [changing, setChanging] = useState<string | null>(null);
  const { data, isLoading, error, refetch } = useQuery({ queryKey: ['subscription'], queryFn: () => get('/settings/subscription') });

  if (isLoading) return <LoadingBlock rows={3} height={90} />;
  if (error) return <ErrorBlock error={error} onRetry={refetch} />;

  const sub = data.subscription;

  return (
    <div className="col gap-6">
      <Card title="Current plan">
        <div className="row between wrap gap-6">
          <div>
            <div className="row gap-4">
              <h2 style={{ textTransform: 'capitalize' }}>{sub.plan}</h2>
              <Badge tone={sub.status === 'active' ? 'good' : sub.status === 'trialing' ? 'accent' : 'warm'}>{label(sub.status)}</Badge>
            </div>
            <div className="small muted">
              {sub.price_eur > 0 ? `€${sub.price_eur} per month · renews ${date(sub.period_end)}` : `Trial ends ${date(sub.trial_ends_at ?? sub.period_end)}`}
            </div>
          </div>
        </div>

        <div className="grid c2 mt-6">
          <div>
            <div className="row between small mb-2">
              <span>Leads this month</span>
              <span className="strong">{number(sub.usage.leads_this_period)} / {number(sub.lead_limit)}</span>
            </div>
            <Progress value={sub.usage.leads_this_period} max={sub.lead_limit} />
          </div>
          <div>
            <div className="row between small mb-2">
              <span>Users</span>
              <span className="strong">{sub.usage.seats_used} / {sub.seats}</span>
            </div>
            <Progress value={sub.usage.seats_used} max={sub.seats} />
          </div>
        </div>
      </Card>

      <div className="grid c3">
        {(['starter', 'growth', 'pro'] as const).map((planKey) => {
          const plan = data.plans[planKey];
          const current = sub.plan === planKey;
          return (
            <div key={planKey} className={`price-card ${planKey === 'growth' ? 'featured' : ''}`}>
              <div className="row between">
                <h3>{plan.name}</h3>
                {current && <Badge tone="accent">Current</Badge>}
              </div>
              <div><span className="price-amount">€{plan.price_eur}</span><span className="muted small"> / month</span></div>
              <p className="small muted" style={{ margin: 0 }}>{plan.description}</p>
              <ul className="price-list">
                {PLAN_FEATURES[planKey].map((feature) => (
                  <li key={feature}><span style={{ color: 'var(--accent)', marginTop: 2 }}><Icon name="check" size={13} /></span>{feature}</li>
                ))}
              </ul>
              {can('billing:write') && !current && (
                <Button variant={planKey === 'growth' ? 'primary' : 'default'} block onClick={() => setChanging(planKey)}>
                  {plan.price_eur > sub.price_eur ? 'Upgrade' : 'Switch'} to {plan.name}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      <div className="banner">
        <Icon name="dot" size={15} />
        <span>
          Plan changes take effect immediately in this installation. Payment collection is handled outside
          VoltaFlow — no card details are stored here.
        </span>
      </div>

      {changing && (
        <ConfirmDialog
          title={`Switch to the ${data.plans[changing].name} plan?`}
          message={`${data.plans[changing].seats} users and ${number(data.plans[changing].lead_limit)} leads a month at €${data.plans[changing].price_eur} per month.`}
          confirmLabel="Switch plan"
          onCancel={() => setChanging(null)}
          onConfirm={async () => {
            try {
              await post('/settings/subscription', { plan: changing });
              setChanging(null);
              queryClient.invalidateQueries({ queryKey: ['subscription'] });
              await reload();
              toast.success('Plan updated.');
            } catch (err) { toast.error(err); setChanging(null); }
          }}
        />
      )}
    </div>
  );
}

// ---------- privacy ----------

function PrivacySection() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { can, organization, reload } = useSession();
  const navigate = useNavigate();
  const [retention, setRetention] = useState<number | null>(null);
  const [policyUrl, setPolicyUrl] = useState<string | null>(null);
  const [demoAction, setDemoAction] = useState<string | null>(null);

  const { data } = useQuery({ queryKey: ['company'], queryFn: () => get('/settings/company') });
  useEffect(() => {
    if (data?.company) {
      setRetention(data.company.retention_months ?? 0);
      setPolicyUrl(data.company.privacy_policy_url ?? '');
    }
  }, [data]);

  return (
    <div className="col gap-6">
      <Card title="Privacy policy" subtitle="Shown on your public lead form so customers know how their data is used.">
        <Field label="Privacy policy URL">
          <input
            value={policyUrl ?? ''} onChange={(e) => setPolicyUrl(e.target.value)} disabled={!can('settings:write')}
            placeholder="https://yourcompany.gr/privacy"
          />
        </Field>
        {can('settings:write') && (
          <Button
            className="mt-4"
            onClick={async () => {
              await patch('/settings/company', { privacy_policy_url: policyUrl });
              queryClient.invalidateQueries({ queryKey: ['company'] });
              toast.success('Saved.');
            }}
          >
            Save
          </Button>
        )}
      </Card>

      <Card title="Retention" subtitle="How long lost leads are kept before they are archived automatically.">
        <Field label="Keep lost leads for (months)" hint="0 keeps everything indefinitely. Leads with a recovery date are never archived early.">
          <input
            type="number" min="0" max="240" value={retention ?? 0} disabled={!can('settings:write')}
            onChange={(e) => setRetention(Number(e.target.value))} style={{ maxWidth: 140 }}
          />
        </Field>
        {can('settings:write') && (
          <Button
            className="mt-4"
            onClick={async () => {
              await patch('/settings/company', { retention_months: retention });
              queryClient.invalidateQueries({ queryKey: ['company'] });
              toast.success('Retention policy saved.');
            }}
          >
            Save
          </Button>
        )}
      </Card>

      <Card title="Subject access and erasure" subtitle="GDPR requests, handled from the customer or lead record.">
        <p className="small muted">
          Open any lead or customer and use the GDPR actions there, or export everything held about a person
          from the API. Erasure anonymises the personal data and keeps the commercial totals your accountant needs.
        </p>
        <div className="row gap-4 wrap mt-4">
          <Button onClick={() => navigate('/app/customers')}>Open customers</Button>
          <Button onClick={() => navigate('/app/leads')}>Open leads</Button>
        </div>
      </Card>

      <Card title="Marketing consent" subtitle="How VoltaFlow keeps operational and marketing messages apart.">
        <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>Operational messages are about the customer's own enquiry and are always allowed.</li>
          <li>Marketing templates are blocked unless the contact has recorded consent, with the reason logged.</li>
          <li>Consent is captured on the website form and shown on every lead and customer record.</li>
          <li>Every send, block and failure is written to the message log and the lead timeline.</li>
        </ul>
      </Card>

      {can('settings:write') && (
        <Card title="Sample data" subtitle={organization?.demo_data_loaded ? 'Sample leads, quotations and projects are loaded.' : 'Load realistic sample data to explore the product.'}>
          <div className="row gap-4">
            {organization?.demo_data_loaded ? (
              <Button variant="danger" onClick={() => setDemoAction('remove')}>Remove sample data</Button>
            ) : (
              <Button onClick={() => setDemoAction('load')}>Load sample data</Button>
            )}
          </div>
        </Card>
      )}

      {demoAction && (
        <ConfirmDialog
          title={demoAction === 'load' ? 'Load sample data?' : 'Remove sample data?'}
          tone={demoAction === 'remove' ? 'danger' : 'primary'}
          confirmLabel={demoAction === 'load' ? 'Load' : 'Remove'}
          message={demoAction === 'load'
            ? 'Twelve realistic leads with quotations, surveys, activities and two won projects are added. They are tagged so they can be removed cleanly later.'
            : 'Every record created by the sample data is deleted. Your own leads and customers are untouched.'}
          onCancel={() => setDemoAction(null)}
          onConfirm={async () => {
            try {
              const result = await post('/data/demo', { action: demoAction });
              setDemoAction(null);
              await reload();
              queryClient.invalidateQueries();
              toast.success(demoAction === 'load'
                ? `Loaded ${result.leads} sample leads.`
                : `Removed ${result.removed?.leads ?? 0} sample leads.`);
            } catch (err) { toast.error(err); setDemoAction(null); }
          }}
        />
      )}
    </div>
  );
}

// ---------- audit ----------

function AuditSection() {
  const [filter, setFilter] = useState('');
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['audit', filter],
    queryFn: () => get(`/data/audit?limit=200${filter ? `&action=${filter}` : ''}`),
  });

  return (
    <Card
      title="Audit log"
      subtitle={data ? `${number(data.total)} recorded events` : undefined}
      actions={
        <select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 'auto' }} aria-label="Filter">
          <option value="">Everything</option>
          <option value="lead">Leads</option>
          <option value="quote">Quotations</option>
          <option value="user">Users</option>
          <option value="automation">Automation</option>
          <option value="settings">Settings</option>
          <option value="integration">Integrations</option>
          <option value="gdpr">GDPR</option>
          <option value="data">Import / export</option>
          <option value="auth">Sign-in</option>
        </select>
      }
      padded={false}
    >
      {isLoading ? <div style={{ padding: 14 }}><LoadingBlock rows={6} height={30} /></div>
        : error ? <div style={{ padding: 14 }}><ErrorBlock error={error} onRetry={refetch} /></div>
          : data.entries.length === 0 ? <EmptyState icon="history" title="Nothing recorded yet" />
            : (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Record</th><th className="hide-mobile">Change</th></tr></thead>
                  <tbody>
                    {data.entries.map((entry: any) => (
                      <tr key={entry.id} style={{ cursor: 'default' }}>
                        <td className="small nowrap dim">{dateTime(entry.created_at)}</td>
                        <td className="small">{entry.user_name}</td>
                        <td className="small mono">{entry.action}</td>
                        <td className="small truncate" style={{ maxWidth: 200 }}>{entry.entity_label ?? entry.entity_id ?? '—'}</td>
                        <td className="tiny dim hide-mobile truncate" style={{ maxWidth: 320 }}>
                          {Object.keys(entry.changes).length > 0 ? JSON.stringify(entry.changes) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
    </Card>
  );
}

// ---------- profile ----------

function ProfileSection() {
  const { user, reload, logout } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();
  const [form, setForm] = useState({ first_name: user?.first_name ?? '', last_name: user?.last_name ?? '', phone: user?.phone ?? '' });
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' });
  const [saving, setSaving] = useState(false);

  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: () => get('/auth/sessions') });

  return (
    <div className="col gap-6">
      <Card title="Your details">
        <div className="grid c2">
          <Field label="First name"><input value={form.first_name} onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))} /></Field>
          <Field label="Last name"><input value={form.last_name} onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))} /></Field>
          <Field label="Phone"><input value={form.phone ?? ''} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} /></Field>
          <Field label="Email" hint="Contact your administrator to change this."><input value={user?.email ?? ''} disabled /></Field>
        </div>
        <Button
          className="mt-4" variant="primary" loading={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await patch('/settings/profile', form);
              await reload();
              toast.success('Profile saved.');
            } catch (err) { toast.error(err); } finally { setSaving(false); }
          }}
        >
          Save
        </Button>
      </Card>

      <Card title="Appearance">
        <Field label="Theme">
          <div className="chips">
            {(['light', 'dark', 'system'] as const).map((option) => (
              <button key={option} type="button" className={`chip ${theme === option ? 'on' : ''}`} onClick={() => setTheme(option)}>
                {label(option)}
              </button>
            ))}
          </div>
        </Field>
      </Card>

      <Card title="Password">
        <div className="grid c2">
          <Field label="Current password">
            <input type="password" value={passwords.currentPassword} autoComplete="current-password"
              onChange={(e) => setPasswords((p) => ({ ...p, currentPassword: e.target.value }))} />
          </Field>
          <Field label="New password" hint="At least 10 characters.">
            <input type="password" value={passwords.newPassword} autoComplete="new-password"
              onChange={(e) => setPasswords((p) => ({ ...p, newPassword: e.target.value }))} />
          </Field>
        </div>
        <Button
          className="mt-4"
          disabled={!passwords.currentPassword || passwords.newPassword.length < 10}
          onClick={async () => {
            try {
              await post('/auth/change-password', passwords);
              setPasswords({ currentPassword: '', newPassword: '' });
              toast.success('Password changed.');
            } catch (err) { toast.error(err); }
          }}
        >
          Change password
        </Button>
      </Card>

      <Card title="Active sessions" subtitle="Where your account is signed in." padded={false}>
        {(sessions?.sessions ?? []).map((session: any) => (
          <div key={session.id} className="attention-item" style={{ cursor: 'default' }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="small truncate">{session.user_agent ?? 'Unknown device'}</div>
              <div className="tiny dim">{session.ip ?? '—'} · started {relative(session.created_at)}</div>
            </div>
          </div>
        ))}
        <div className="card-foot">
          <Button variant="danger" onClick={async () => { await logout(); navigate('/login'); }}>Sign out</Button>
        </div>
      </Card>
    </div>
  );
}
