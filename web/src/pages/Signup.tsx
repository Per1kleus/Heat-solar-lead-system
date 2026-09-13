import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session';
import { Button, Field, Icon } from '../components/ui';
import { ApiError } from '../lib/api';

const SERVICES = [
  { key: 'pv', label: 'Photovoltaic systems' },
  { key: 'heat_pump', label: 'Heat pumps' },
  { key: 'battery', label: 'Battery storage' },
  { key: 'ev_charger', label: 'EV chargers' },
];

export default function Signup() {
  const { signup } = useSession();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    companyName: '', firstName: '', lastName: '', email: '', password: '', phone: '',
  });
  const [services, setServices] = useState<string[]>(['pv', 'heat_pump']);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(false);

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const fieldError = (path: string) => (error instanceof ApiError ? error.fieldError(path) : undefined);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await signup({ ...form, services });
      navigate('/app/setup', { replace: true });
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card" style={{ maxWidth: 460 }}>
        <Link to="/" className="row gap-4 mb-6" style={{ color: 'inherit', textDecoration: 'none', fontWeight: 700, fontSize: 17, justifyContent: 'center' }}>
          <span className="brand-mark">
            <svg width="14" height="14" viewBox="0 0 32 32" aria-hidden="true">
              <path d="M17.5 5 9 18h5.5L13 27l9.5-14H17z" fill="currentColor" />
            </svg>
          </span>
          VoltaFlow
        </Link>

        <div className="card">
          <div className="card-body">
            <h1 style={{ fontSize: 19, marginBottom: 4 }}>Start free</h1>
            <p className="small muted mb-4">14 days on the Growth feature set. No card required.</p>

            {error && !(error instanceof ApiError && error.fields?.length) && (
              <div className="banner error mb-4" role="alert">
                <Icon name="alert" size={15} />
                <span>{error.message}</span>
              </div>
            )}

            <form onSubmit={submit} className="col gap-6">
              <Field label="Company name" required error={fieldError('companyName')} htmlFor="company">
                <input id="company" value={form.companyName} onChange={set('companyName')} required placeholder="Helios Energy Solutions" />
              </Field>
              <div className="grid c2">
                <Field label="First name" required error={fieldError('firstName')} htmlFor="first">
                  <input id="first" value={form.firstName} onChange={set('firstName')} required autoComplete="given-name" />
                </Field>
                <Field label="Last name" required error={fieldError('lastName')} htmlFor="last">
                  <input id="last" value={form.lastName} onChange={set('lastName')} required autoComplete="family-name" />
                </Field>
              </div>
              <Field label="Work email" required error={fieldError('email')} htmlFor="email2">
                <input id="email2" type="email" value={form.email} onChange={set('email')} required autoComplete="username" />
              </Field>
              <Field label="Phone" htmlFor="phone">
                <input id="phone" value={form.phone} onChange={set('phone')} autoComplete="tel" placeholder="+30 ..." />
              </Field>
              <Field label="Password" required hint="At least 10 characters." error={fieldError('password')} htmlFor="pw">
                <input id="pw" type="password" value={form.password} onChange={set('password')} required minLength={10} autoComplete="new-password" />
              </Field>

              <div className="field">
                <label>What do you install?</label>
                <div className="chips">
                  {SERVICES.map((service) => (
                    <button
                      key={service.key} type="button"
                      className={`chip ${services.includes(service.key) ? 'on' : ''}`}
                      onClick={() => setServices((s) => (s.includes(service.key) ? s.filter((x) => x !== service.key) : [...s, service.key]))}
                    >
                      {service.label}
                    </button>
                  ))}
                </div>
                <span className="hint">This decides which technical questions appear on leads and forms.</span>
              </div>

              <Button type="submit" variant="primary" loading={loading} block disabled={services.length === 0}>
                Create my workspace
              </Button>
            </form>

            <p className="small center mt-4" style={{ marginBottom: 0 }}>
              Already have an account? <Link to="/login">Sign in</Link>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
