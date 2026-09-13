import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post } from '../lib/api';
import { Button, Field, Icon, useToast } from '../components/ui';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<{ devToken?: string } | null>(null);
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const toast = useToast();

  const request = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    try {
      const result = await post('/auth/forgot-password', { email: email.trim() });
      setSent(result);
      if (result.devToken) setToken(result.devToken);
    } catch (err) {
      toast.error(err);
    } finally {
      setLoading(false);
    }
  };

  const reset = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    try {
      await post('/auth/reset-password', { token: token.trim(), password });
      setDone(true);
    } catch (err) {
      toast.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="card">
          <div className="card-body">
            <h1 style={{ fontSize: 19, marginBottom: 4 }}>Reset your password</h1>

            {done ? (
              <>
                <div className="banner success mb-4"><Icon name="check" size={15} /><span>Password updated. You can sign in now.</span></div>
                <Link className="btn primary block" to="/login">Go to sign in</Link>
              </>
            ) : !sent ? (
              <>
                <p className="small muted mb-4">Enter your work email and we will create a reset link for you.</p>
                <form onSubmit={request} className="col gap-6">
                  <Field label="Work email" htmlFor="email">
                    <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                  </Field>
                  <Button type="submit" variant="primary" loading={loading} block>Send reset link</Button>
                </form>
              </>
            ) : (
              <>
                <div className="banner info mb-4">
                  <Icon name="dot" size={15} />
                  <span>
                    If that email has an account, a reset link has been created.
                    {sent.devToken ? ' Because email is not connected on this installation, the token is shown below.' : ' Check your inbox.'}
                  </span>
                </div>
                <form onSubmit={reset} className="col gap-6">
                  <Field label="Reset token" hint="From the reset email." htmlFor="token">
                    <input id="token" value={token} onChange={(e) => setToken(e.target.value)} required />
                  </Field>
                  <Field label="New password" hint="At least 10 characters." htmlFor="pw">
                    <input id="pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} />
                  </Field>
                  <Button type="submit" variant="primary" loading={loading} block>Set new password</Button>
                </form>
              </>
            )}

            <p className="small center mt-4" style={{ marginBottom: 0 }}><Link to="/login">Back to sign in</Link></p>
          </div>
        </div>
      </div>
    </div>
  );
}
