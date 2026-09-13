import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { post, setAccessToken } from '../lib/api';
import { useSession } from '../lib/session';
import { Button, Field, Icon } from '../components/ui';
import { ApiError } from '../lib/api';

export default function AcceptInvite() {
  const [params] = useSearchParams();
  const [token, setToken] = useState(params.get('token') ?? '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { reload } = useSession();

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const data = await post('/auth/accept-invite', { token: token.trim(), password });
      setAccessToken(data.accessToken);
      await reload();
      navigate('/app', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That invitation could not be accepted.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="card">
          <div className="card-body">
            <h1 style={{ fontSize: 19, marginBottom: 4 }}>Join your team</h1>
            <p className="small muted mb-4">Choose a password and your account is ready.</p>
            {error && <div className="banner error mb-4" role="alert"><Icon name="alert" size={15} /><span>{error}</span></div>}
            <form onSubmit={submit} className="col gap-6">
              <Field label="Invitation token" htmlFor="token">
                <input id="token" value={token} onChange={(e) => setToken(e.target.value)} required />
              </Field>
              <Field label="Choose a password" hint="At least 10 characters." htmlFor="pw">
                <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} autoComplete="new-password" />
              </Field>
              <Button type="submit" variant="primary" loading={loading} block>Activate my account</Button>
            </form>
            <p className="small center mt-4" style={{ marginBottom: 0 }}><Link to="/login">Back to sign in</Link></p>
          </div>
        </div>
      </div>
    </div>
  );
}
