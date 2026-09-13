import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../lib/session';
import { Button, Field, Icon } from '../components/ui';
import { ApiError } from '../lib/api';

export default function Login() {
  const { login } = useSession();
  const navigate = useNavigate();
  const location = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email.trim(), password);
      navigate(location.state?.from ?? '/app', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not sign in. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
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
            <h1 style={{ fontSize: 19, marginBottom: 4 }}>Sign in</h1>
            <p className="small muted mb-4">Welcome back. Your pipeline is waiting.</p>

            {error && (
              <div className="banner error mb-4" role="alert">
                <Icon name="alert" size={15} />
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={submit} className="col gap-6">
              <Field label="Work email" htmlFor="email">
                <input
                  id="email" type="email" value={email} required autoComplete="username"
                  onChange={(e) => setEmail(e.target.value)} placeholder="you@company.gr"
                />
              </Field>
              <Field label="Password" htmlFor="password">
                <input
                  id="password" type="password" value={password} required autoComplete="current-password"
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
              <Button type="submit" variant="primary" loading={loading} block>Sign in</Button>
            </form>

            <div className="row between mt-4 small">
              <Link to="/forgot-password">Forgotten your password?</Link>
              <Link to="/signup">Create an account</Link>
            </div>
          </div>
        </div>

        <p className="small dim center mt-4">
          By signing in you agree to our terms and privacy policy.
        </p>
      </div>
    </div>
  );
}
