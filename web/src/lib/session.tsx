import {
  createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode,
} from 'react';
import { api, post, setAccessToken, getAccessToken } from './api';

export interface SessionUser {
  id: string;
  org_id: string;
  email: string;
  first_name: string;
  last_name: string;
  full_name: string;
  role: 'owner' | 'admin' | 'sales_manager' | 'salesperson' | 'technician';
  avatar_color: string;
  theme: string;
  phone: string | null;
  permissions: string[];
}

export interface Organization {
  id: string; name: string; logo_url: string | null; currency: string;
  services: string[]; vat_rate: number; onboarding_done: boolean; onboarding_step: number;
  demo_data_loaded: boolean; public_form_token: string; timezone: string; stale_lead_hours: number;
}

export interface Subscription {
  plan: string; status: string; price_eur: number; seats: number; lead_limit: number;
  features: string[]; trial_ends_at: string | null; period_end: string;
  usage: { leads_this_period: number; seats_used: number; ai_calls: number };
  limits: { leads_pct: number; seats_pct: number };
}

interface SessionState {
  user: SessionUser | null;
  organization: Organization | null;
  subscription: Subscription | null;
  aiAvailable: boolean;
  notificationCount: number;
  loading: boolean;
  can: (permission: string) => boolean;
  hasFeature: (feature: string) => boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (input: SignupInput) => Promise<void>;
  logout: () => Promise<void>;
  reload: () => Promise<void>;
  setNotificationCount: (n: number) => void;
}

export interface SignupInput {
  companyName: string; firstName: string; lastName: string;
  email: string; password: string; phone?: string; services?: string[];
}

const SessionContext = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [organization, setOrganization] = useState<Organization | null>(null);
  const [subscription, setSubscription] = useState<Subscription | null>(null);
  const [aiAvailable, setAiAvailable] = useState(false);
  const [notificationCount, setNotificationCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    const data = await api('/me');
    setUser(data.user);
    setOrganization(data.organization);
    setSubscription(data.subscription);
    setAiAvailable(data.ai_available);
    setNotificationCount(data.notification_count ?? 0);
  }, []);

  // Restore the session from the refresh cookie on first load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setAccessToken(data.accessToken);
          if (!cancelled) await loadMe();
        }
      } catch {
        // Not signed in — the public pages still render.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [loadMe]);

  // Keep the short-lived access token fresh while the tab is open.
  useEffect(() => {
    if (!user) return;
    const timer = setInterval(() => {
      fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setAccessToken(d.accessToken))
        .catch(() => undefined);
    }, 20 * 60 * 1000);
    return () => clearInterval(timer);
  }, [user]);

  const login = useCallback(async (email: string, password: string) => {
    const data = await post('/auth/login', { email, password });
    setAccessToken(data.accessToken);
    await loadMe();
  }, [loadMe]);

  const signup = useCallback(async (input: SignupInput) => {
    const data = await post('/auth/signup', input);
    setAccessToken(data.accessToken);
    await loadMe();
  }, [loadMe]);

  const logout = useCallback(async () => {
    try { await post('/auth/logout'); } catch { /* the cookie is cleared regardless */ }
    setAccessToken(null);
    setUser(null);
    setOrganization(null);
    setSubscription(null);
  }, []);

  const value = useMemo<SessionState>(() => ({
    user, organization, subscription, aiAvailable, notificationCount, loading,
    can: (permission) => user?.permissions.includes(permission) ?? false,
    hasFeature: (feature) => subscription?.features.includes(feature) ?? false,
    login, signup, logout, reload: loadMe, setNotificationCount,
  }), [user, organization, subscription, aiAvailable, notificationCount, loading, login, signup, logout, loadMe]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}

export { getAccessToken };

// ---------- theme ----------

export type Theme = 'light' | 'dark' | 'system';

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem('vf-theme') as Theme) ?? 'system',
  );

  useEffect(() => {
    const apply = () => {
      const dark = theme === 'dark'
        || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    if (theme !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  const setTheme = useCallback((next: Theme) => {
    localStorage.setItem('vf-theme', next);
    setThemeState(next);
  }, []);

  return [theme, setTheme];
}
