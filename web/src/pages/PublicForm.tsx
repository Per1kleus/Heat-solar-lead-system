import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

const TYPE_LABELS: Record<string, string> = {
  pv: 'Photovoltaic',
  heat_pump: 'Heat pump',
  battery: 'Battery storage',
  ev_charger: 'EV charger',
  other: 'Something else',
};

/** Simple line icons so the form looks like part of a professional company site. */
function ServiceIcon({ type }: { type: string }) {
  const paths: Record<string, React.ReactNode> = {
    pv: <><path d="M5 16 8 6h8l3 10z" /><path d="M3 16h18M12 6v10M8.8 11h6.4" /><path d="M12 20v-4" /></>,
    heat_pump: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M8 9.5c1.2 1 1.2 2 0 3s-1.2 2 0 3M12 9.5c1.2 1 1.2 2 0 3s-1.2 2 0 3M16 9.5c1.2 1 1.2 2 0 3s-1.2 2 0 3" /></>,
    battery: <><rect x="4" y="6" width="14" height="12" rx="2" /><path d="M18 10h2v4h-2" /><path d="M8 10v4M12 10v4" /></>,
    ev_charger: <><rect x="4" y="4" width="10" height="16" rx="2" /><path d="M14 9h3a2 2 0 0 1 2 2v5a1.5 1.5 0 0 0 3 0v-5" /><path d="m9.5 8-2 3.5H10l-.5 3 2.5-4H9.7z" /></>,
    other: <><circle cx="12" cy="12" r="8.5" /><path d="M12 8v4M12 15.5v.5" /></>,
  };
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[type] ?? paths.other}
    </svg>
  );
}

/**
 * The customer-facing form an installer embeds on their website. Mobile-first,
 * three short steps, and only the questions that match what they picked.
 */
export default function PublicForm() {
  const { token = '' } = useParams();
  const [params] = useSearchParams();
  const embedded = params.get('embed') === '1';
  const rootRef = useRef<HTMLDivElement>(null);

  const [step, setStep] = useState(0);
  const [types, setTypes] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string, any>>({});
  const [contact, setContact] = useState({
    first_name: '', last_name: '', phone: '', email: '',
    address: '', city: '', postal_code: '', preferred_contact: 'phone', notes: '',
  });
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<{ message: string; reference: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, error: loadError } = useQuery({
    queryKey: ['public-form', token],
    queryFn: async () => {
      const response = await fetch(`/api/public/form/${token}`);
      if (!response.ok) throw new Error('This form is no longer available.');
      return response.json();
    },
    retry: false,
  });

  // Keep the host page's iframe sized to the content.
  useEffect(() => {
    if (!embedded) return;
    const report = () => {
      const height = rootRef.current?.scrollHeight ?? 0;
      window.parent?.postMessage({ source: 'voltaflow', type: 'resize', height: height + 24 }, '*');
    };
    report();
    const observer = new ResizeObserver(report);
    if (rootRef.current) observer.observe(rootRef.current);
    return () => observer.disconnect();
  }, [embedded, step, done, types]);

  const questions = useMemo(() => {
    if (!data) return [];
    const seen = new Set<string>();
    const list: any[] = [];
    for (const type of types) {
      for (const question of data.questions[type] ?? []) {
        if (seen.has(question.key)) continue;
        seen.add(question.key);
        list.push(question);
      }
    }
    return list;
  }, [data, types]);

  if (isLoading) {
    return <div className="lead-form"><div className="skeleton" style={{ height: 260 }} /></div>;
  }
  if (loadError || !data) {
    return (
      <div className="lead-form">
        <div className="banner error" role="alert">
          <span>This enquiry form is no longer available. Please contact the company directly.</span>
        </div>
      </div>
    );
  }

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const utm: Record<string, string> = {};
      for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'gclid', 'fbclid']) {
        const value = params.get(key);
        if (value) utm[key] = value;
      }
      const response = await fetch(`/api/public/form/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...contact,
          email: contact.email || undefined,
          project_types: types,
          answers,
          consent_marketing: consent,
          utm,
          campaign: params.get('utm_campaign') ?? undefined,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error?.message ?? 'Your enquiry could not be sent. Please try again.');
      }
      setDone({ message: payload.message, reference: payload.reference });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Your enquiry could not be sent. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div ref={rootRef} className="lead-form">
        <div className="card" style={{ padding: 26, textAlign: 'center' }}>
          <div style={{ fontSize: 34, marginBottom: 10 }} aria-hidden="true">✓</div>
          <h2 style={{ marginBottom: 8 }}>Thank you</h2>
          <p className="muted">{done.message}</p>
          <p className="small dim" style={{ marginBottom: 0 }}>Your reference is {done.reference}.</p>
        </div>
      </div>
    );
  }

  const canContinueStep0 = types.length > 0;
  const canSubmit = contact.first_name.trim().length > 0 && contact.phone.trim().length >= 6;

  return (
    <div ref={rootRef} className="lead-form">
      {!embedded && (
        <header className="center mb-6">
          {data.company.logo_url
            ? <img src={data.company.logo_url} alt={data.company.name} style={{ maxHeight: 56, marginBottom: 10 }} />
            : <h1 style={{ marginBottom: 6 }}>{data.company.name}</h1>}
          <p className="muted small" style={{ margin: 0 }}>Request a quotation</p>
        </header>
      )}

      <div className="steps-bar" aria-hidden="true">
        {[0, 1, 2].map((index) => <i key={index} className={index <= step ? 'done' : ''} />)}
      </div>

      {error && (
        <div className="banner error mb-4" role="alert"><span>{error}</span></div>
      )}

      {step === 0 && (
        <div className="lead-form-step">
          <h2>What are you interested in?</h2>
          <p className="muted small" style={{ marginTop: -6 }}>Choose one or more.</p>
          <div className="service-grid">
            {data.services.map((service: any) => (
              <button
                key={service.key} type="button"
                className={`service-tile ${types.includes(service.key) ? 'on' : ''}`}
                aria-pressed={types.includes(service.key)}
                onClick={() => setTypes((t) => (t.includes(service.key) ? t.filter((x) => x !== service.key) : [...t, service.key]))}
              >
                <ServiceIcon type={service.key} />
                {TYPE_LABELS[service.key] ?? service.label}
              </button>
            ))}
          </div>
          <button className="btn primary lg block" disabled={!canContinueStep0} onClick={() => setStep(1)}>
            Continue
          </button>
        </div>
      )}

      {step === 1 && (
        <div className="lead-form-step">
          <h2>Tell us about your property</h2>
          <p className="muted small" style={{ marginTop: -6 }}>
            Everything here is optional — it just means our first call is more useful.
          </p>
          {questions.map((question) => (
            <div key={question.key} className="field">
              <label htmlFor={`q-${question.key}`}>{question.label}</label>
              {question.type === 'select' ? (
                <select
                  id={`q-${question.key}`} value={answers[question.key] ?? ''}
                  onChange={(e) => setAnswers((a) => ({ ...a, [question.key]: e.target.value }))}
                >
                  <option value="">Please choose</option>
                  {question.options.map((option: string) => <option key={option} value={option}>{option}</option>)}
                </select>
              ) : question.type === 'boolean' ? (
                <div className="chips">
                  {[['yes', 'Yes'], ['no', 'No']].map(([value, text]) => (
                    <button
                      key={value} type="button"
                      className={`chip ${answers[question.key] === (value === 'yes') ? 'on' : ''}`}
                      onClick={() => setAnswers((a) => ({ ...a, [question.key]: value === 'yes' }))}
                    >
                      {text}
                    </button>
                  ))}
                </div>
              ) : question.type === 'textarea' ? (
                <textarea
                  id={`q-${question.key}`} rows={4} value={answers[question.key] ?? ''}
                  onChange={(e) => setAnswers((a) => ({ ...a, [question.key]: e.target.value }))}
                />
              ) : (
                <input
                  id={`q-${question.key}`} type={question.type === 'number' ? 'number' : 'text'}
                  inputMode={question.type === 'number' ? 'decimal' : undefined}
                  value={answers[question.key] ?? ''}
                  onChange={(e) => setAnswers((a) => ({ ...a, [question.key]: e.target.value }))}
                />
              )}
              {question.help && <span className="hint">{question.help}</span>}
            </div>
          ))}
          {data.custom_fields.map((field: any) => (
            <div key={field.key} className="field">
              <label htmlFor={`c-${field.key}`}>{field.label}</label>
              {field.type === 'select' ? (
                <select id={`c-${field.key}`} value={answers[field.key] ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [field.key]: e.target.value }))}>
                  <option value="">Please choose</option>
                  {field.options.map((option: string) => <option key={option} value={option}>{option}</option>)}
                </select>
              ) : (
                <input id={`c-${field.key}`} value={answers[field.key] ?? ''} onChange={(e) => setAnswers((a) => ({ ...a, [field.key]: e.target.value }))} />
              )}
            </div>
          ))}

          <div className="row gap-4">
            <button className="btn lg" onClick={() => setStep(0)}>Back</button>
            <button className="btn primary lg grow" onClick={() => setStep(2)}>Continue</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="lead-form-step">
          <h2>How can we reach you?</h2>
          <div className="grid c2">
            <div className="field">
              <label htmlFor="fn">First name *</label>
              <input id="fn" value={contact.first_name} onChange={(e) => setContact((c) => ({ ...c, first_name: e.target.value }))} autoComplete="given-name" required />
            </div>
            <div className="field">
              <label htmlFor="ln">Last name</label>
              <input id="ln" value={contact.last_name} onChange={(e) => setContact((c) => ({ ...c, last_name: e.target.value }))} autoComplete="family-name" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="tel">Phone *</label>
            <input id="tel" type="tel" inputMode="tel" value={contact.phone} onChange={(e) => setContact((c) => ({ ...c, phone: e.target.value }))} autoComplete="tel" required />
          </div>
          <div className="field">
            <label htmlFor="em">Email</label>
            <input id="em" type="email" inputMode="email" value={contact.email} onChange={(e) => setContact((c) => ({ ...c, email: e.target.value }))} autoComplete="email" />
          </div>
          <div className="field">
            <label htmlFor="ad">Installation address</label>
            <input id="ad" value={contact.address} onChange={(e) => setContact((c) => ({ ...c, address: e.target.value }))} autoComplete="street-address" />
          </div>
          <div className="grid c2">
            <div className="field">
              <label htmlFor="pc">Postal code</label>
              <input id="pc" inputMode="numeric" value={contact.postal_code} onChange={(e) => setContact((c) => ({ ...c, postal_code: e.target.value }))} autoComplete="postal-code" />
            </div>
            <div className="field">
              <label htmlFor="ci">City</label>
              <input id="ci" value={contact.city} onChange={(e) => setContact((c) => ({ ...c, city: e.target.value }))} autoComplete="address-level2" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="pref">Best way to reach you</label>
            <select id="pref" value={contact.preferred_contact} onChange={(e) => setContact((c) => ({ ...c, preferred_contact: e.target.value }))}>
              <option value="phone">Phone call</option>
              <option value="whatsapp">WhatsApp</option>
              <option value="email">Email</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="nt">Anything else we should know?</label>
            <textarea id="nt" rows={3} value={contact.notes} onChange={(e) => setContact((c) => ({ ...c, notes: e.target.value }))} />
          </div>

          <label className="check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span className="small">
              I would also like occasional news about offers and new products.
              <span className="hint" style={{ display: 'block' }}>
                Optional. We will contact you about this enquiry either way.
              </span>
            </span>
          </label>

          <p className="tiny dim">
            Your details are sent to {data.company.name} so they can answer your enquiry.
            {data.company.privacy_policy_url && (
              <> See their <a href={data.company.privacy_policy_url} target="_blank" rel="noreferrer">privacy policy</a>.</>
            )}
          </p>

          <div className="row gap-4">
            <button className="btn lg" onClick={() => setStep(1)} disabled={submitting}>Back</button>
            <button className="btn primary lg grow" onClick={submit} disabled={!canSubmit || submitting}>
              {submitting ? 'Sending…' : 'Send my enquiry'}
            </button>
          </div>
          {!canSubmit && (
            <p className="tiny dim center" style={{ marginBottom: 0 }}>
              We need at least your first name and a phone number.
            </p>
          )}
        </div>
      )}

      {!embedded && (
        <footer className="center mt-6 small dim">
          {data.company.phone && <div>Or call us on <a href={`tel:${data.company.phone}`}>{data.company.phone}</a></div>}
        </footer>
      )}
    </div>
  );
}
