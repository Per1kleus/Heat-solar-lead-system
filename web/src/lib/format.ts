export function money(value: unknown, currency = 'EUR', decimals = 0): string {
  const n = Number(value ?? 0);
  return new Intl.NumberFormat('en-GB', {
    style: 'currency', currency,
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  }).format(n);
}

/** Compact money for dense cards: €12.4k, €1.2M. */
export function moneyShort(value: unknown, currency = 'EUR'): string {
  const n = Number(value ?? 0);
  if (Math.abs(n) >= 1_000_000) return `${symbol(currency)}${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 10_000) return `${symbol(currency)}${Math.round(n / 1000)}k`;
  return money(n, currency);
}

function symbol(currency: string): string {
  return ({ EUR: '€', USD: '$', GBP: '£' } as Record<string, string>)[currency] ?? `${currency} `;
}

export function number(value: unknown, decimals = 0): string {
  return new Intl.NumberFormat('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    .format(Number(value ?? 0));
}

export function percent(value: unknown, decimals = 0): string {
  return `${number(value, decimals)}%`;
}

export function date(value?: string | null, style: 'short' | 'long' | 'day' = 'short'): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  if (style === 'day') return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  if (style === 'long') return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function dateTime(value?: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function time(value?: string | null): string {
  if (!value) return '';
  return new Date(value).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** "in 3 days" / "2 hours ago" — the phrasing salespeople scan for. */
export function relative(value?: string | null): string {
  if (!value) return '—';
  const target = new Date(value).getTime();
  if (Number.isNaN(target)) return '—';
  const diff = target - Date.now();
  const abs = Math.abs(diff);
  const minute = 60_000, hour = 60 * minute, day = 24 * hour;

  if (abs < minute) return 'just now';
  const fmt = new Intl.RelativeTimeFormat('en-GB', { numeric: 'auto' });
  if (abs < hour) return fmt.format(Math.round(diff / minute), 'minute');
  if (abs < day) return fmt.format(Math.round(diff / hour), 'hour');
  if (abs < 30 * day) return fmt.format(Math.round(diff / day), 'day');
  if (abs < 365 * day) return fmt.format(Math.round(diff / (30 * day)), 'month');
  return fmt.format(Math.round(diff / (365 * day)), 'year');
}

export function isOverdue(value?: string | null): boolean {
  return Boolean(value) && new Date(value!).getTime() < Date.now();
}

export function isToday(value?: string | null): boolean {
  if (!value) return false;
  const d = new Date(value);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

export function initials(name?: string | null): string {
  if (!name) return '—';
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('');
}

export function toInputDate(value?: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

export function toInputDateTime(value?: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const tzOffset = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - tzOffset).toISOString().slice(0, 16);
}

export function fromInputDateTime(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export const PROJECT_TYPE_LABELS: Record<string, string> = {
  pv: 'Photovoltaic',
  heat_pump: 'Heat pump',
  battery: 'Battery',
  ev_charger: 'EV charger',
  other: 'Other',
};

export const PROJECT_TYPE_ICONS: Record<string, string> = {
  pv: '☀', heat_pump: '♨', battery: '▮', ev_charger: '⚡', other: '•',
};

export function projectTypeLabel(types: string[] | string | null | undefined): string {
  const list = Array.isArray(types) ? types : typeof types === 'string' ? [types] : [];
  if (list.length === 0) return 'Not specified';
  return list.map((t) => PROJECT_TYPE_LABELS[t] ?? t).join(' + ');
}

export const STATUS_LABELS: Record<string, string> = {
  open: 'Open', won: 'Won', lost: 'Lost',
  draft: 'Draft', sent: 'Sent', viewed: 'Viewed', awaiting_response: 'Awaiting response',
  accepted: 'Accepted', rejected: 'Rejected', expired: 'Expired', cancelled: 'Cancelled',
  scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Completed', no_show: 'No show',
  not_started: 'Not started', commissioned: 'Commissioned', handed_over: 'Handed over',
  opportunity: 'Opportunity', unpaid: 'Unpaid', deposit_paid: 'Deposit paid',
  partially_paid: 'Partially paid', paid: 'Paid',
};

export function label(value?: string | null): string {
  if (!value) return '—';
  return STATUS_LABELS[value] ?? value.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

export const PRIORITY_META: Record<string, { label: string; badge: string; mark: string }> = {
  urgent: { label: 'Urgent', badge: 'danger', mark: '🔴' },
  high: { label: 'High', badge: 'warm', mark: '🟠' },
  normal: { label: 'Normal', badge: '', mark: '🟡' },
  low: { label: 'Low', badge: 'cold', mark: '🔵' },
};

export function csvParse(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const clean = text.replace(/^﻿/, '');
  const delimiter = detectDelimiter(clean);
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;

  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i];
    if (quoted) {
      if (char === '"') {
        if (clean[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === delimiter) { record.push(field); field = ''; continue; }
    if (char === '\n') { record.push(field); records.push(record); record = []; field = ''; continue; }
    if (char === '\r') continue;
    field += char;
  }
  if (field.length > 0 || record.length > 0) { record.push(field); records.push(record); }

  const [headerRow, ...dataRows] = records.filter((r) => r.some((c) => c.trim() !== ''));
  if (!headerRow) return { headers: [], rows: [] };
  const headers = headerRow.map((h, index) => h.trim() || `Column ${index + 1}`);
  const rows = dataRows.map((row) =>
    Object.fromEntries(headers.map((header, index) => [header, (row[index] ?? '').trim()])));
  return { headers, rows };
}

function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length] as const);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 1 ? counts[0][0] : ',';
}
