import {
  createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState,
  type ReactNode, type ButtonHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { initials } from '../lib/format';
import { ApiError } from '../lib/api';

// ---------- icons (inline, no icon-font dependency) ----------

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const path = ICONS[name] ?? ICONS.dot;
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {path}
    </svg>
  );
}

export type IconName = keyof typeof ICONS;

const ICONS = {
  dashboard: <><rect x="3" y="3" width="7" height="8" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="11" width="7" height="10" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /></>,
  leads: <><path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" /><circle cx="9" cy="7" r="3.5" /><path d="M18 8.5h4M20 6.5v4" /></>,
  pipeline: <><rect x="3" y="4" width="5" height="16" rx="1.5" /><rect x="10" y="4" width="5" height="11" rx="1.5" /><rect x="17" y="4" width="4" height="7" rx="1.5" /></>,
  tasks: <><path d="M9 6h11M9 12h11M9 18h11" /><path d="m3 6 1.4 1.4L7 4.8" /><path d="m3 12 1.4 1.4L7 10.8" /><path d="m3 18 1.4 1.4L7 16.8" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>,
  quote: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
  survey: <><path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M9 21v-7h6v7" /></>,
  customers: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  projects: <><path d="M3 7h18v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M9 7V4h6v3" /><path d="M3 12h18" /></>,
  analytics: <><path d="M3 20h18" /><rect x="5" y="11" width="3.5" height="6" rx="1" /><rect x="11" y="7" width="3.5" height="10" rx="1" /><rect x="17" y="13" width="3.5" height="4" rx="1" /></>,
  automation: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.2 2.2M16.9 16.9l2.2 2.2M19.1 4.9l-2.2 2.2M7.1 16.9l-2.2 2.2" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.6 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H7a1.7 1.7 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V7a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  bell: <><path d="M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.2-3.2" /></>,
  plus: <><path d="M12 5v14M5 12h14" /></>,
  check: <><path d="m5 13 4 4L19 7" /></>,
  x: <><path d="M18 6 6 18M6 6l12 12" /></>,
  phone: <><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.4 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.5c.9.4 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" /></>,
  mail: <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m2 7 10 6 10-6" /></>,
  whatsapp: <><path d="M3 21l1.7-5A8.5 8.5 0 1 1 8 19.4z" /><path d="M8.8 9.2c0 3 2.5 5.4 5.4 5.4" /></>,
  note: <><path d="M4 4h16v12l-4 4H4z" /><path d="M20 16h-4v4" /><path d="M8 9h8M8 13h5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  alert: <><path d="M12 3 2 20h20z" /><path d="M12 10v4M12 17.5v.5" /></>,
  fire: <><path d="M12 22c4 0 7-2.7 7-6.5 0-4.8-5-6.5-4-11.5C10 5 6 8.5 6 13c0 1.7.7 3.2 1.8 4.3" /><path d="M12 22c-2 0-3.4-1.4-3.4-3.2 0-2.3 2.4-3.1 2-5.3 1.8 1 3.4 2.8 3.4 5.3 0 1.8-1.4 3.2-2 3.2z" /></>,
  euro: <><path d="M17 5.5A6.5 6.5 0 0 0 7 11v2a6.5 6.5 0 0 0 10 5.5" /><path d="M4 11h9M4 14h8" /></>,
  upload: <><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></>,
  download: <><path d="M12 4v12M7 11l5 5 5-5" /><path d="M4 18v1a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1" /></>,
  doc: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>,
  user: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>,
  logout: <><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" /><path d="M16 16l4-4-4-4M20 12H10" /></>,
  menu: <><path d="M4 7h16M4 12h16M4 17h16" /></>,
  chevron: <><path d="m9 5 7 7-7 7" /></>,
  chevronDown: <><path d="m5 9 7 7 7-7" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" /></>,
  moon: <><path d="M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z" /></>,
  inbox: <><path d="M3 12h5l2 3h4l2-3h5" /><path d="M4.5 5h15l1.5 7v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-6z" /></>,
  sparkles: <><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><path d="m6.3 6.3 2.2 2.2M15.5 15.5l2.2 2.2M17.7 6.3l-2.2 2.2M8.5 15.5l-2.2 2.2" /></>,
  trash: <><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13M9 7V4h6v3" /></>,
  edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
  link: <><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" /></>,
  filter: <><path d="M3 5h18l-7 8v6l-4 2v-8z" /></>,
  refresh: <><path d="M21 12a9 9 0 0 1-15.5 6.2L3 16" /><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8" /><path d="M21 4v4h-4M3 20v-4h4" /></>,
  camera: <><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" /><circle cx="12" cy="13" r="3.5" /></>,
  shield: <><path d="M12 3l8 3v6c0 5-3.4 8.3-8 9-4.6-.7-8-4-8-9V6z" /><path d="m9 12 2 2 4-4" /></>,
  grid: <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 4v4h4" /><path d="M12 8v4l3 2" /></>,
  target: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1" /></>,
  dot: <><circle cx="12" cy="12" r="3" /></>,
};

// ---------- toasts ----------

interface Toast { id: number; message: string; tone: 'info' | 'success' | 'error'; detail?: string }

interface ToastApi {
  show: (message: string, tone?: Toast['tone'], detail?: string) => void;
  success: (message: string, detail?: string) => void;
  error: (error: unknown, fallback?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const remove = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);

  const show = useCallback((message: string, tone: Toast['tone'] = 'info', detail?: string) => {
    const id = nextId.current++;
    setToasts((t) => [...t, { id, message, tone, detail }]);
    setTimeout(() => remove(id), tone === 'error' ? 8000 : 4000);
  }, [remove]);

  const api = useMemo<ToastApi>(() => ({
    show,
    success: (message, detail) => show(message, 'success', detail),
    error: (error, fallback = 'Something went wrong. Please try again.') => {
      const message = error instanceof ApiError ? error.message
        : error instanceof Error ? error.message : fallback;
      show(message, 'error');
    },
  }), [show]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="toasts" role="status" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast ${toast.tone}`}>
              <span style={{ marginTop: 1 }}>
                <Icon name={toast.tone === 'error' ? 'alert' : toast.tone === 'success' ? 'check' : 'dot'} size={15} />
              </span>
              <div className="grow">
                <div style={{ fontWeight: 550 }}>{toast.message}</div>
                {toast.detail && <div className="small muted">{toast.detail}</div>}
              </div>
              <button className="btn ghost sm icon" onClick={() => remove(toast.id)} aria-label="Dismiss">
                <Icon name="x" size={13} />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}

// ---------- primitives ----------

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: IconName;
  block?: boolean;
}

export function Button({
  variant = 'default', size = 'md', loading, icon, block, children, className = '', disabled, ...rest
}: ButtonProps) {
  return (
    <button
      className={[
        'btn',
        variant !== 'default' ? variant : '',
        size !== 'md' ? size : '',
        block ? 'block' : '',
        !children && icon ? 'icon' : '',
        className,
      ].filter(Boolean).join(' ')}
      disabled={disabled || loading}
      {...rest}
    >
      {loading ? <span className="spinner" /> : icon ? <Icon name={icon} size={size === 'sm' ? 13 : 15} /> : null}
      {children}
    </button>
  );
}

export function Field({
  label: text, hint, error, required, children, htmlFor,
}: { label?: string; hint?: string; error?: string; required?: boolean; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="field">
      {text && (
        <label htmlFor={htmlFor}>
          {text}{required && <span style={{ color: 'var(--danger)' }}> *</span>}
        </label>
      )}
      {children}
      {error ? <span className="error">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} />;
}

export function Badge({
  children, tone = '', outline, title,
}: { children: ReactNode; tone?: string; outline?: boolean; title?: string }) {
  return <span className={`badge ${tone} ${outline ? 'outline' : ''}`} title={title}>{children}</span>;
}

export function Avatar({ name, color, size = 'md' }: { name?: string | null; color?: string | null; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span
      className={`avatar ${size === 'md' ? '' : size}`}
      style={{ background: color || 'var(--ink-3)' }}
      title={name ?? undefined}
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

export function TemperatureBadge({ temperature, score }: { temperature: string; score?: number }) {
  const meta: Record<string, { label: string; mark: string }> = {
    hot: { label: 'Hot', mark: '🔥' },
    warm: { label: 'Warm', mark: '🟡' },
    cold: { label: 'Cold', mark: '🔵' },
  };
  const m = meta[temperature] ?? meta.cold;
  return (
    <Badge tone={temperature} title={score !== undefined ? `Lead score ${score}/100` : undefined}>
      <span aria-hidden="true">{m.mark}</span>{m.label}{score !== undefined ? ` ${score}` : ''}
    </Badge>
  );
}

export function ScoreRing({ score, size = 42 }: { score: number; size?: number }) {
  const radius = (size - 5) / 2;
  const circumference = 2 * Math.PI * radius;
  const tone = score >= 80 ? 'var(--hot)' : score >= 50 ? 'var(--warm)' : 'var(--cold)';
  return (
    <span className="score-ring" style={{ width: size, height: size }} title={`Lead score ${score} of 100`}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--surface-3)" strokeWidth="3.5" />
        <circle
          cx={size / 2} cy={size / 2} r={radius} fill="none" stroke={tone} strokeWidth="3.5"
          strokeLinecap="round" strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - Math.max(0, Math.min(100, score)) / 100)}
        />
      </svg>
      <span style={{ color: tone }}>{score}</span>
    </span>
  );
}

export function Modal({
  title, subtitle, onClose, children, footer, width = 'md',
}: {
  title: string; subtitle?: string; onClose: () => void; children: ReactNode;
  footer?: ReactNode; width?: 'narrow' | 'md' | 'wide';
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return createPortal(
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${width === 'md' ? '' : width}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <div className="small muted" style={{ marginTop: 2 }}>{subtitle}</div>}
          </div>
          <Button variant="ghost" size="sm" icon="x" onClick={onClose} aria-label="Close" />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function ConfirmDialog({
  title, message, confirmLabel = 'Confirm', tone = 'primary', onConfirm, onCancel, loading,
}: {
  title: string; message: ReactNode; confirmLabel?: string;
  tone?: 'primary' | 'danger'; onConfirm: () => void; onCancel: () => void; loading?: boolean;
}) {
  return (
    <Modal
      title={title} onClose={onCancel} width="narrow"
      footer={
        <>
          <Button onClick={onCancel} disabled={loading}>Cancel</Button>
          <Button variant={tone} onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
        </>
      }
    >
      <div className="muted">{message}</div>
    </Modal>
  );
}

export function EmptyState({
  icon = 'inbox', title, message, action,
}: { icon?: IconName; title: string; message?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon"><Icon name={icon} size={20} /></div>
      <h3>{title}</h3>
      {message && <p className="small muted" style={{ maxWidth: '46ch', margin: '0 auto 14px' }}>{message}</p>}
      {action}
    </div>
  );
}

export function LoadingBlock({ rows = 4, height = 46 }: { rows?: number; height?: number }) {
  return (
    <div className="col gap-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height }} />
      ))}
    </div>
  );
}

export function ErrorBlock({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof ApiError ? error.message
    : error instanceof Error ? error.message : 'Something went wrong.';
  return (
    <div className="banner error" role="alert">
      <Icon name="alert" size={16} />
      <div className="grow">{message}</div>
      {onRetry && <Button size="sm" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function Card({
  title, subtitle, actions, children, footer, padded = true,
}: {
  title?: ReactNode; subtitle?: string; actions?: ReactNode;
  children: ReactNode; footer?: ReactNode; padded?: boolean;
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-head">
          <div className="grow" style={{ minWidth: 0 }}>
            {typeof title === 'string' ? <h2>{title}</h2> : title}
            {subtitle && <div className="small muted" style={{ marginTop: 2 }}>{subtitle}</div>}
          </div>
          {actions && <div className="row gap-4">{actions}</div>}
        </div>
      )}
      {padded ? <div className="card-body">{children}</div> : children}
      {footer && <div className="card-foot">{footer}</div>}
    </section>
  );
}

export function Kpi({
  label, value, sub, tone, onClick, href,
}: {
  label: string; value: ReactNode; sub?: string;
  tone?: 'alert' | 'good' | 'warn'; onClick?: () => void; href?: string;
}) {
  const content = (
    <>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </>
  );
  const className = `kpi ${tone ?? ''}`;
  if (href) return <a className={className} href={href}>{content}</a>;
  if (onClick) {
    return (
      <button className={className} onClick={onClick} style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit' }}>
        {content}
      </button>
    );
  }
  return <div className={className}>{content}</div>;
}

export function Tabs({
  tabs, active, onChange,
}: { tabs: { key: string; label: string; count?: number }[]; active: string; onChange: (key: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.key} role="tab" aria-selected={active === tab.key}
          className={`tab ${active === tab.key ? 'active' : ''}`}
          onClick={() => onChange(tab.key)}
        >
          {tab.label}
          {tab.count !== undefined && tab.count > 0 && <span className="nav-count" style={{ marginLeft: 6 }}>{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

/** Debounced text input — used for every search box so typing does not hammer the API. */
export function useDebounced<T>(value: T, delay = 280): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function SearchInput({
  value, onChange, placeholder = 'Search…', autoFocus,
}: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean }) {
  const id = useId();
  return (
    <div style={{ position: 'relative', minWidth: 180 }}>
      <span style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-3)', pointerEvents: 'none' }}>
        <Icon name="search" size={14} />
      </span>
      <input
        id={id} type="search" value={value} autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder} aria-label={placeholder}
        style={{ paddingLeft: 30 }}
      />
    </div>
  );
}

export function Progress({ value, max = 100 }: { value: number; max?: number }) {
  const pct = Math.min(100, Math.round((value / Math.max(max, 1)) * 100));
  return (
    <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <i className={pct >= 90 ? 'danger' : pct >= 75 ? 'warn' : ''} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Simple async action button that surfaces loading, success and error states. */
export function useAsync<T extends (...args: any[]) => Promise<any>>(fn: T) {
  const [loading, setLoading] = useState(false);
  const toast = useToast();
  const run = useCallback(async (...args: Parameters<T>) => {
    setLoading(true);
    try {
      return await fn(...args);
    } catch (err) {
      toast.error(err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [fn, toast]);
  return { loading, run } as { loading: boolean; run: (...args: Parameters<T>) => Promise<Awaited<ReturnType<T>>> };
}
