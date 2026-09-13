import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { useSession, useTheme } from '../lib/session';
import { Avatar, Button, Icon, useDebounced, type IconName } from './ui';
import { money } from '../lib/format';

interface NavEntry { to: string; label: string; icon: IconName; permission?: string; feature?: string; badge?: 'tasks' }

const NAV: { group: string; items: NavEntry[] }[] = [
  {
    group: 'Sell',
    items: [
      { to: '/app', label: 'Dashboard', icon: 'dashboard' },
      { to: '/app/leads', label: 'Leads', icon: 'leads' },
      { to: '/app/pipeline', label: 'Pipeline', icon: 'pipeline' },
      { to: '/app/tasks', label: 'Follow-ups', icon: 'tasks', badge: 'tasks' },
      { to: '/app/calendar', label: 'Calendar', icon: 'calendar' },
      { to: '/app/quotations', label: 'Quotations', icon: 'quote', permission: 'quotes:read:own' },
    ],
  },
  {
    group: 'Deliver',
    items: [
      { to: '/app/surveys', label: 'Site surveys', icon: 'survey', permission: 'surveys:read' },
      { to: '/app/customers', label: 'Customers', icon: 'customers', permission: 'customers:read' },
      { to: '/app/projects', label: 'Installations', icon: 'projects', permission: 'projects:read' },
    ],
  },
  {
    group: 'Grow',
    items: [
      { to: '/app/analytics', label: 'Analytics', icon: 'analytics', permission: 'analytics:view' },
      { to: '/app/recovery', label: 'Lost lead recovery', icon: 'refresh', permission: 'analytics:view' },
      { to: '/app/automations', label: 'Automation', icon: 'automation', permission: 'automation:read' },
    ],
  },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const { user, organization, subscription, notificationCount, setNotificationCount, logout, can } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const [theme, setTheme] = useTheme();

  useEffect(() => { setMenuOpen(false); setUserMenu(false); }, [location.pathname]);

  // Live counts for the navigation badges; polled gently, not on every render.
  const { data: counts } = useQuery({
    queryKey: ['nav-counts'],
    queryFn: () => get('/tasks?bucket=overdue&limit=1'),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
  const { data: notifications } = useQuery({
    queryKey: ['notifications-unread'],
    queryFn: () => get('/notifications?unread=1&limit=1'),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (notifications?.unread !== undefined) setNotificationCount(notifications.unread);
  }, [notifications?.unread, setNotificationCount]);

  const overdue = counts?.counts?.overdue ?? 0;
  const trialDays = subscription?.trial_ends_at
    ? Math.ceil((new Date(subscription.trial_ends_at).getTime() - Date.now()) / 86_400_000)
    : null;

  return (
    <div className="app">
      {menuOpen && <div className="sidebar-backdrop" onClick={() => setMenuOpen(false)} />}

      <aside className={`sidebar ${menuOpen ? 'open' : ''}`}>
        <Link to="/app" className="sidebar-brand" style={{ color: 'inherit', textDecoration: 'none' }}>
          <span className="brand-mark">
            <svg width="14" height="14" viewBox="0 0 32 32" aria-hidden="true">
              <path d="M17.5 5 9 18h5.5L13 27l9.5-14H17z" fill="currentColor" />
            </svg>
          </span>
          <span className="truncate">{organization?.name ?? 'VoltaFlow'}</span>
        </Link>

        <nav className="sidebar-nav">
          {NAV.map((group) => {
            const items = group.items.filter((item) => !item.permission || can(item.permission));
            if (items.length === 0) return null;
            return (
              <div key={group.group}>
                <div className="nav-group-label">{group.group}</div>
                {items.map((item) => (
                  <NavLink
                    key={item.to} to={item.to} end={item.to === '/app'}
                    className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
                  >
                    <Icon name={item.icon} size={16} />
                    <span className="grow truncate">{item.label}</span>
                    {item.badge === 'tasks' && overdue > 0 && <span className="nav-count alert">{overdue}</span>}
                  </NavLink>
                ))}
              </div>
            );
          })}

          {can('settings:read') && (
            <div>
              <div className="nav-group-label">Configure</div>
              <NavLink to="/app/settings" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
                <Icon name="settings" size={16} />
                <span className="grow">Settings</span>
              </NavLink>
            </div>
          )}
        </nav>

        <div className="sidebar-foot">
          {subscription && can('billing:read') && (
            <Link to="/app/settings/billing" className="card" style={{ display: 'block', padding: 10, textDecoration: 'none', color: 'inherit' }}>
              <div className="row between">
                <span className="tiny strong" style={{ textTransform: 'capitalize' }}>{subscription.plan} plan</span>
                {trialDays !== null && trialDays >= 0 && <span className="badge accent">{trialDays}d left</span>}
              </div>
              <div className="tiny dim" style={{ marginTop: 4 }}>
                {subscription.usage.leads_this_period} / {subscription.lead_limit} leads this month
              </div>
              <div className="progress" style={{ marginTop: 5 }}>
                <i
                  className={subscription.limits.leads_pct >= 90 ? 'danger' : subscription.limits.leads_pct >= 75 ? 'warn' : ''}
                  style={{ width: `${Math.min(100, subscription.limits.leads_pct)}%` }}
                />
              </div>
            </Link>
          )}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <Button variant="ghost" size="sm" icon="menu" className="only-mobile" onClick={() => setMenuOpen(true)} aria-label="Open menu" />
          <GlobalSearch />
          <div className="grow" />

          <Button
            variant="ghost" size="sm"
            icon={theme === 'dark' ? 'sun' : 'moon'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          />

          <Link to="/app/notifications" className="btn ghost sm icon" style={{ position: 'relative' }} aria-label={`Notifications${notificationCount ? `, ${notificationCount} unread` : ''}`}>
            <Icon name="bell" size={16} />
            {notificationCount > 0 && (
              <span style={{
                position: 'absolute', top: 2, right: 2, minWidth: 15, height: 15, padding: '0 3px',
                borderRadius: 999, background: 'var(--danger)', color: '#fff',
                fontSize: 9.5, fontWeight: 700, display: 'grid', placeItems: 'center',
              }}>
                {notificationCount > 99 ? '99+' : notificationCount}
              </span>
            )}
          </Link>

          <div style={{ position: 'relative' }}>
            <button
              className="btn ghost sm" onClick={() => setUserMenu((v) => !v)}
              aria-haspopup="menu" aria-expanded={userMenu}
              style={{ padding: 3, paddingRight: 8 }}
            >
              <Avatar name={user?.full_name} color={user?.avatar_color} size="sm" />
              <span className="hide-mobile small">{user?.first_name}</span>
              <Icon name="chevronDown" size={12} />
            </button>
            {userMenu && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 50 }} onClick={() => setUserMenu(false)} />
                <div className="card" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', width: 226, zIndex: 51, boxShadow: 'var(--shadow-lg)' }}>
                  <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)' }}>
                    <div className="strong truncate">{user?.full_name}</div>
                    <div className="tiny dim truncate">{user?.email}</div>
                    <div className="badge accent" style={{ marginTop: 5 }}>{roleLabel(user?.role)}</div>
                  </div>
                  <div style={{ padding: 6 }}>
                    <Link to="/app/settings/profile" className="nav-item"><Icon name="user" size={15} />My profile</Link>
                    {can('settings:read') && <Link to="/app/settings" className="nav-item"><Icon name="settings" size={15} />Settings</Link>}
                    <button
                      className="nav-item" style={{ width: '100%', border: 0, background: 'none', font: 'inherit', cursor: 'pointer' }}
                      onClick={async () => { await logout(); navigate('/login'); }}
                    >
                      <Icon name="logout" size={15} />Sign out
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </header>

        {children}
      </div>

      <MobileTabBar />
    </div>
  );
}

function roleLabel(role?: string): string {
  return ({
    owner: 'Owner', admin: 'Administrator', sales_manager: 'Sales manager',
    salesperson: 'Salesperson', technician: 'Technician',
  } as Record<string, string>)[role ?? ''] ?? '—';
}

function MobileTabBar() {
  const { can, user } = useSession();
  const technician = user?.role === 'technician';
  const items: NavEntry[] = technician
    ? [
        { to: '/app', label: 'Today', icon: 'dashboard' },
        { to: '/app/surveys', label: 'Surveys', icon: 'survey' },
        { to: '/app/calendar', label: 'Calendar', icon: 'calendar' },
        { to: '/app/projects', label: 'Jobs', icon: 'projects' },
      ]
    : [
        { to: '/app', label: 'Today', icon: 'dashboard' },
        { to: '/app/leads', label: 'Leads', icon: 'leads' },
        { to: '/app/pipeline', label: 'Pipeline', icon: 'pipeline' },
        { to: '/app/tasks', label: 'Follow-ups', icon: 'tasks' },
      ];
  return (
    <nav className="tabbar" aria-label="Main">
      {items.filter((i) => !i.permission || can(i.permission)).map((item) => (
        <NavLink key={item.to} to={item.to} end={item.to === '/app'} className={({ isActive }) => (isActive ? 'active' : '')}>
          <Icon name={item.icon} size={19} />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

function GlobalSearch() {
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const debounced = useDebounced(term, 250);
  const navigate = useNavigate();
  const boxRef = useRef<HTMLDivElement>(null);

  const { data, isFetching } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => get(`/data/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.trim().length >= 2,
    staleTime: 20_000,
  });

  const results = data?.results ?? [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        boxRef.current?.querySelector('input')?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const goTo = (item: any) => {
    setOpen(false);
    setTerm('');
    navigate(`/app${item.link}`);
  };

  return (
    <div ref={boxRef} style={{ position: 'relative', flex: '1 1 320px', maxWidth: 420 }}>
      <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-3)', pointerEvents: 'none' }}>
        <Icon name="search" size={14} />
      </span>
      <input
        type="search" value={term} placeholder="Search leads, customers, quotations…"
        aria-label="Search everything"
        onChange={(e) => { setTerm(e.target.value); setOpen(true); setCursor(0); }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 160)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setCursor((c) => Math.min(c + 1, results.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
          if (e.key === 'Enter' && results[cursor]) { e.preventDefault(); goTo(results[cursor]); }
          if (e.key === 'Escape') setOpen(false);
        }}
        style={{ paddingLeft: 30 }}
      />
      {open && debounced.trim().length >= 2 && (
        <div className="search-results">
          {isFetching && results.length === 0 && <div className="search-item muted small">Searching…</div>}
          {!isFetching && results.length === 0 && (
            <div className="search-item muted small">No match for “{debounced}”.</div>
          )}
          {results.map((item: any, index: number) => (
            <div
              key={`${item.type}-${item.id}`}
              className={`search-item ${index === cursor ? 'active' : ''}`}
              onMouseDown={() => goTo(item)}
              onMouseEnter={() => setCursor(index)}
            >
              <Icon name={searchIcon(item.type)} size={15} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="truncate" style={{ fontWeight: 550 }}>{item.title}</div>
                <div className="tiny dim truncate">{item.subtitle}</div>
              </div>
              {item.meta?.value ? <span className="tiny dim nowrap">{money(item.meta.value)}</span> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function searchIcon(type: string): IconName {
  return ({ lead: 'leads', customer: 'customers', quotation: 'quote', project: 'projects', task: 'tasks' } as Record<string, IconName>)[type] ?? 'dot';
}
