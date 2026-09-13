import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, patch, put } from '../lib/api';
import { useSession } from '../lib/session';
import { Badge, Button, Card, Field, Icon, LoadingBlock, useToast } from '../components/ui';
import { number } from '../lib/format';

export default function Onboarding() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { reload, organization } = useSession();
  const [step, setStep] = useState(0);

  const { data, isLoading, refetch } = useQuery({ queryKey: ['onboarding'], queryFn: () => get('/onboarding') });
  useEffect(() => { if (data) setStep(data.current_step ?? 0); }, [data?.current_step]);

  if (isLoading || !data) {
    return <div className="page" style={{ maxWidth: 900 }}><LoadingBlock rows={3} height={80} /></div>;
  }

  const steps = data.steps;

  const goTo = async (next: number, complete = false) => {
    setStep(next);
    try {
      await post('/onboarding/step', { step: next, complete });
      if (complete) {
        await reload();
        queryClient.invalidateQueries();
        navigate('/app', { replace: true });
      }
    } catch (err) { toast.error(err); }
  };

  const refreshAll = () => { refetch(); queryClient.invalidateQueries({ queryKey: ['onboarding'] }); };

  return (
    <div style={{ minHeight: '100%', background: 'var(--bg)' }}>
      <header style={{ borderBottom: '1px solid var(--border)', background: 'var(--surface)' }}>
        <div className="row between" style={{ maxWidth: 1100, margin: '0 auto', padding: '12px 20px' }}>
          <div className="row gap-4" style={{ fontWeight: 700 }}>
            <span className="brand-mark">
              <svg width="14" height="14" viewBox="0 0 32 32" aria-hidden="true">
                <path d="M17.5 5 9 18h5.5L13 27l9.5-14H17z" fill="currentColor" />
              </svg>
            </span>
            Set up {organization?.name}
          </div>
          <Button variant="ghost" size="sm" onClick={() => goTo(steps.length - 1, true)}>Skip for now</Button>
        </div>
      </header>

      <div className="page" style={{ maxWidth: 1100 }}>
        <div className="steps-bar">
          {steps.map((_: any, index: number) => <i key={index} className={index <= step ? 'done' : ''} />)}
        </div>

        <div className="wizard">
          <ol className="wizard-steps">
            {steps.map((item: any, index: number) => (
              <li
                key={item.key}
                className={`wizard-step ${index === step ? 'active' : ''} ${index < step ? 'done' : ''}`}
                onClick={() => setStep(index)}
              >
                <span className="n">{index < step ? '✓' : index + 1}</span>
                <div>
                  <div className="small strong">{item.title}</div>
                  {index === step && <div className="tiny dim">{item.description}</div>}
                </div>
              </li>
            ))}
          </ol>

          <div className="col gap-6">
            {step === 0 && <CompanyStep data={data} onDone={refreshAll} />}
            {step === 1 && <ServicesStep data={data} onDone={refreshAll} />}
            {step === 2 && <TeamStep data={data} onDone={refreshAll} />}
            {step === 3 && <PipelineStep data={data} />}
            {step === 4 && <CommunicationStep data={data} onDone={refreshAll} />}
            {step === 5 && <FormStep data={data} />}
            {step === 6 && <ImportStep />}
            {step === 7 && <AutomationStep data={data} />}
            {step === 8 && <ReadyStep data={data} onDone={refreshAll} />}

            <div className="row between">
              <Button onClick={() => goTo(Math.max(0, step - 1))} disabled={step === 0}>Back</Button>
              {step < steps.length - 1 ? (
                <Button variant="primary" onClick={() => goTo(step + 1)}>Continue</Button>
              ) : (
                <Button variant="primary" onClick={() => goTo(step, true)}>Open my dashboard</Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function CompanyStep({ data, onDone }: { data: any; onDone: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: data.company.name ?? '', phone: data.company.phone ?? '', email: data.company.email ?? '',
    address: data.company.address ?? '', city: data.company.city ?? '', postal_code: data.company.postal_code ?? '',
    vat_number: data.company.vat_number ?? '', website: data.company.website ?? '',
  });
  const [saving, setSaving] = useState(false);
  const set = (key: string) => (e: any) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <Card title="Company information" subtitle="This appears on every quotation you send, so it is worth getting right.">
      <div className="grid c2">
        <Field label="Company name" required><input value={form.name} onChange={set('name')} /></Field>
        <Field label="Website"><input value={form.website} onChange={set('website')} placeholder="https://" /></Field>
        <Field label="Phone"><input value={form.phone} onChange={set('phone')} /></Field>
        <Field label="Email"><input type="email" value={form.email} onChange={set('email')} /></Field>
        <Field label="Address"><input value={form.address} onChange={set('address')} /></Field>
        <div className="grid c2">
          <Field label="Postal code"><input value={form.postal_code} onChange={set('postal_code')} /></Field>
          <Field label="City"><input value={form.city} onChange={set('city')} /></Field>
        </div>
        <Field label="VAT number"><input value={form.vat_number} onChange={set('vat_number')} /></Field>
      </div>
      <Button
        className="mt-4" variant="primary" loading={saving}
        onClick={async () => {
          setSaving(true);
          try {
            await patch('/settings/company', { ...form, email: form.email || null });
            toast.success('Saved.');
            onDone();
          } catch (err) { toast.error(err); } finally { setSaving(false); }
        }}
      >
        Save company details
      </Button>
    </Card>
  );
}

function ServicesStep({ data, onDone }: { data: any; onDone: () => void }) {
  const toast = useToast();
  const [services, setServices] = useState<string[]>(data.company.services ?? []);
  const [saving, setSaving] = useState(false);

  return (
    <Card title="What do you install?" subtitle="Only the relevant technical questions then appear on leads and on your website form.">
      <div className="service-grid">
        {[
          { key: 'pv', label: 'Photovoltaic', icon: 'analytics' as const },
          { key: 'heat_pump', label: 'Heat pumps', icon: 'survey' as const },
          { key: 'battery', label: 'Batteries', icon: 'grid' as const },
          { key: 'ev_charger', label: 'EV chargers', icon: 'target' as const },
        ].map((service) => (
          <button
            key={service.key} type="button"
            className={`service-tile ${services.includes(service.key) ? 'on' : ''}`}
            onClick={() => setServices((s) => (s.includes(service.key) ? s.filter((x) => x !== service.key) : [...s, service.key]))}
          >
            <Icon name={service.icon} size={24} />
            {service.label}
          </button>
        ))}
      </div>
      <Button
        className="mt-6" variant="primary" loading={saving} disabled={services.length === 0}
        onClick={async () => {
          setSaving(true);
          try {
            await patch('/settings/company', { services });
            toast.success('Saved.');
            onDone();
          } catch (err) { toast.error(err); } finally { setSaving(false); }
        }}
      >
        Save
      </Button>
    </Card>
  );
}

function TeamStep({ data, onDone }: { data: any; onDone: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState([{ first_name: '', last_name: '', email: '', role: 'salesperson' }]);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<any>(null);

  return (
    <div className="col gap-6">
      <Card title="Who is on your team?" subtitle="Salespeople see their own leads; managers see everything; technicians get the site surveys.">
        <div className="col gap-4">
          {data.users.map((user: any) => (
            <div key={user.id} className="row gap-4">
              <Badge tone="accent">{user.role.replace('_', ' ')}</Badge>
              <span className="grow">{user.full_name}</span>
              <span className="small dim">{user.email}</span>
              <Badge tone={user.status === 'active' ? 'good' : 'warm'}>{user.status}</Badge>
            </div>
          ))}
        </div>

        <div className="col gap-4 mt-6">
          {rows.map((row, index) => (
            <div key={index} className="grid c4" style={{ gap: 8 }}>
              <input placeholder="First name" value={row.first_name} onChange={(e) => setRows((r) => r.map((x, i) => (i === index ? { ...x, first_name: e.target.value } : x)))} aria-label="First name" />
              <input placeholder="Last name" value={row.last_name} onChange={(e) => setRows((r) => r.map((x, i) => (i === index ? { ...x, last_name: e.target.value } : x)))} aria-label="Last name" />
              <input placeholder="Email" type="email" value={row.email} onChange={(e) => setRows((r) => r.map((x, i) => (i === index ? { ...x, email: e.target.value } : x)))} aria-label="Email" />
              <select value={row.role} onChange={(e) => setRows((r) => r.map((x, i) => (i === index ? { ...x, role: e.target.value } : x)))} aria-label="Role">
                <option value="salesperson">Salesperson</option>
                <option value="sales_manager">Sales manager</option>
                <option value="technician">Technician</option>
                <option value="admin">Administrator</option>
              </select>
            </div>
          ))}
          <Button size="sm" icon="plus" onClick={() => setRows((r) => [...r, { first_name: '', last_name: '', email: '', role: 'salesperson' }])}>
            Add another
          </Button>
        </div>

        <Button
          className="mt-6" variant="primary" loading={saving}
          disabled={!rows.some((r) => r.email.trim() && r.first_name.trim())}
          onClick={async () => {
            setSaving(true);
            try {
              const members = rows.filter((r) => r.email.trim() && r.first_name.trim());
              const response = await post('/onboarding/team', { members });
              setResult(response);
              setRows([{ first_name: '', last_name: '', email: '', role: 'salesperson' }]);
              onDone();
              toast.success(`${response.created.length} user(s) added.`);
            } catch (err) { toast.error(err); } finally { setSaving(false); }
          }}
        >
          Add these people
        </Button>
      </Card>

      {result && (
        <Card title="Invitation links">
          <p className="small muted">{result.note}</p>
          {result.created.filter((u: any) => u.invite_link).map((u: any) => (
            <div key={u.id} className="row between gap-4 small" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              <span>{u.first_name} {u.last_name}</span>
              <code className="mono tiny truncate" style={{ maxWidth: 280 }}>{window.location.origin}{u.invite_link}</code>
              <Button size="sm" onClick={() => navigator.clipboard?.writeText(`${window.location.origin}${u.invite_link}`)}>Copy</Button>
            </div>
          ))}
          {result.skipped.length > 0 && (
            <div className="banner warn mt-4">
              <Icon name="alert" size={15} />
              <div>
                {result.skipped.map((s: any) => <div key={s.email} className="small">{s.email}: {s.reason}</div>)}
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function PipelineStep({ data }: { data: any }) {
  const navigate = useNavigate();
  return (
    <Card title="Your sales pipeline" subtitle="These ten stages are what solar and heat-pump installers actually use. Adjust them any time.">
      <div className="col gap-4">
        {data.stages.map((stage: any) => (
          <div key={stage.id} className="row gap-4">
            <span className="dot" style={{ color: stage.color }} />
            <span className="grow strong">{stage.name}</span>
            <span className="small dim">{stage.probability}% win probability</span>
          </div>
        ))}
      </div>
      <div className="banner mt-6">
        <Icon name="target" size={15} />
        <span>
          The probability on each stage is what turns your pipeline into a revenue forecast.
          Change them in Settings → Pipeline once you know your own numbers.
        </span>
      </div>
      <Button className="mt-4" onClick={() => navigate('/app/settings/pipeline')}>Open pipeline settings</Button>
    </Card>
  );
}

function CommunicationStep({ data, onDone }: { data: any; onDone: () => void }) {
  const toast = useToast();
  const [smtp, setSmtp] = useState({ host: '', port: 587, from_address: '', from_name: data.company.name ?? '' });
  const [creds, setCreds] = useState({ user: '', pass: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connected = data.integrations.email === 'connected';

  return (
    <div className="col gap-6">
      <Card title="Connect your email" subtitle="So acknowledgements and quotations go out from your own mailbox.">
        {connected ? (
          <div className="banner success"><Icon name="check" size={15} /><span>Email is connected.</span></div>
        ) : (
          <>
            <div className="banner mb-4">
              <Icon name="shield" size={15} />
              <span>
                VoltaFlow verifies the connection against your mail server before saving it.
                Until it succeeds, nothing is marked as sent — you will always know what actually went out.
              </span>
            </div>
            {error && <div className="banner error mb-4"><Icon name="alert" size={15} /><span>{error}</span></div>}
            <div className="grid c2">
              <Field label="SMTP host"><input value={smtp.host} onChange={(e) => setSmtp((s) => ({ ...s, host: e.target.value }))} placeholder="smtp.your-provider.com" /></Field>
              <Field label="Port"><input type="number" value={smtp.port} onChange={(e) => setSmtp((s) => ({ ...s, port: Number(e.target.value) }))} /></Field>
              <Field label="Send from address"><input type="email" value={smtp.from_address} onChange={(e) => setSmtp((s) => ({ ...s, from_address: e.target.value }))} /></Field>
              <Field label="Send from name"><input value={smtp.from_name} onChange={(e) => setSmtp((s) => ({ ...s, from_name: e.target.value }))} /></Field>
              <Field label="Username"><input value={creds.user} onChange={(e) => setCreds((c) => ({ ...c, user: e.target.value }))} autoComplete="off" /></Field>
              <Field label="Password"><input type="password" value={creds.pass} onChange={(e) => setCreds((c) => ({ ...c, pass: e.target.value }))} autoComplete="new-password" /></Field>
            </div>
            <Button
              className="mt-4" variant="primary" loading={saving} disabled={!smtp.host || !creds.user}
              onClick={async () => {
                setSaving(true); setError(null);
                try {
                  const result = await put('/settings/integrations/smtp', { config: smtp, secrets: creds, enabled: true });
                  toast.success(result.message);
                  onDone();
                } catch (err: any) {
                  setError(err?.message ?? 'Could not connect.');
                } finally { setSaving(false); }
              }}
            >
              Verify &amp; connect
            </Button>
          </>
        )}
      </Card>

      <Card title="WhatsApp and AI (optional)" subtitle="Both can be connected later from Settings → Communication.">
        <div className="col gap-4 small muted">
          <div className="row gap-4">
            <Badge tone={data.integrations.whatsapp === 'connected' ? 'good' : ''}>{data.integrations.whatsapp}</Badge>
            <span>WhatsApp Business — send and log WhatsApp messages against the lead.</span>
          </div>
          <div className="row gap-4">
            <Badge tone={data.integrations.ai === 'connected' ? 'good' : ''}>{data.integrations.ai}</Badge>
            <span>AI assistance — lead summaries, suggested next actions and draft replies.</span>
          </div>
        </div>
      </Card>
    </div>
  );
}

function FormStep({ data }: { data: any }) {
  const toast = useToast();
  const formUrl = `${window.location.origin}/f/${data.form_token}`;
  const snippet = `<div id="voltaflow-form"></div>\n<script src="${window.location.origin}/embed.js" data-voltaflow-token="${data.form_token}" defer></script>`;

  return (
    <Card title="Your website form is ready" subtitle="Paste this snippet where you want the form to appear. Enquiries arrive assigned, scored and with a first follow-up already scheduled.">
      <textarea readOnly rows={3} value={snippet} className="mono" style={{ fontSize: 12 }} onFocus={(e) => e.target.select()} />
      <div className="row gap-4 wrap mt-4">
        <Button icon="link" onClick={() => { navigator.clipboard?.writeText(snippet); toast.success('Snippet copied.'); }}>Copy snippet</Button>
        <a className="btn primary" href={formUrl} target="_blank" rel="noreferrer">Preview the form</a>
      </div>
      <div className="banner mt-6">
        <Icon name="target" size={15} />
        <span>
          The form asks different questions depending on whether the customer picks photovoltaic, a heat pump,
          a battery or an EV charger — so your first call already has the numbers you need.
        </span>
      </div>
    </Card>
  );
}

function ImportStep() {
  const navigate = useNavigate();
  return (
    <Card title="Bring your existing leads in" subtitle="A CSV export from your spreadsheet, your old CRM, or your mailbox.">
      <p className="small muted">
        The importer maps your columns, validates every row, detects duplicates against what is already here,
        and shows you exactly what will happen before anything is written.
      </p>
      <Button className="mt-4" variant="primary" icon="upload" onClick={() => navigate('/app/import')}>
        Open the importer
      </Button>
      <p className="small dim mt-4" style={{ marginBottom: 0 }}>
        You can do this later — nothing else depends on it.
      </p>
    </Card>
  );
}

function AutomationStep({ data }: { data: any }) {
  const navigate = useNavigate();
  return (
    <Card title="Follow-up automation" subtitle="These rules are already running. They are what stops a lead being forgotten.">
      <div className="col gap-4">
        {data.automation_rules.map((rule: any) => (
          <div key={rule.id} className="row gap-4 top">
            <span style={{ color: rule.is_active ? 'var(--good)' : 'var(--ink-3)', marginTop: 2 }}>
              <Icon name={rule.is_active ? 'check' : 'x'} size={15} />
            </span>
            <div className="grow">
              <div className="strong small">{rule.name}</div>
              <div className="tiny dim">{rule.description}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="banner mt-6">
        <Icon name="shield" size={15} />
        <span>
          Customer-facing messages only go out through a channel you have connected, and marketing messages
          need recorded consent. Everything else is internal: tasks and notifications for your own team.
        </span>
      </div>
      <Button className="mt-4" onClick={() => navigate('/app/automations')}>Review the automation rules</Button>
    </Card>
  );
}

function ReadyStep({ data, onDone }: { data: any; onDone: () => void }) {
  const toast = useToast();
  const [loading, setLoading] = useState(false);

  return (
    <div className="col gap-6">
      <Card title="You are set up">
        <p className="muted">
          Your pipeline, scoring, follow-up automation and website form are all live.
          The dashboard opens on “what needs my attention today”.
        </p>
        <div className="grid c2 mt-4">
          {[
            ['Company', data.company.name],
            ['Services', (data.company.services ?? []).join(', ') || 'none chosen'],
            ['Team', `${data.users.length} user${data.users.length === 1 ? '' : 's'}`],
            ['Pipeline', `${data.stages.length} stages`],
            ['Automation', `${data.automation_rules.filter((r: any) => r.is_active).length} rules active`],
            ['Leads', number(data.lead_count)],
          ].map(([key, value]) => (
            <div key={key as string} className="row between small" style={{ padding: '5px 0', borderBottom: '1px solid var(--border)' }}>
              <span className="dim">{key}</span><span className="strong">{value}</span>
            </div>
          ))}
        </div>
      </Card>

      {!data.demo_data_loaded && data.lead_count === 0 && (
        <Card title="Want to see it with data first?" subtitle="Twelve realistic leads, quotations, surveys and two won projects — removable in one click.">
          <Button
            variant="primary" loading={loading}
            onClick={async () => {
              setLoading(true);
              try {
                const result = await post('/onboarding/demo-data');
                toast.success(`Loaded ${result.leads} sample leads.`);
                onDone();
              } catch (err) { toast.error(err); } finally { setLoading(false); }
            }}
          >
            Load sample data
          </Button>
        </Card>
      )}
    </div>
  );
}
