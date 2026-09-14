export interface ApiErrorBody {
  code: string;
  message: string;
  fields?: { path: string; message: string }[];
  details?: any;
}

export class ApiError extends Error {
  status: number;
  code: string;
  fields?: { path: string; message: string }[];
  details?: any;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.status = status;
    this.code = body.code;
    this.fields = body.fields;
    this.details = body.details;
  }
  /** Per-field message for inline form errors. */
  fieldError(path: string): string | undefined {
    return this.fields?.find((f) => f.path === path)?.message;
  }
}

let accessToken: string | null = null;
let refreshPromise: Promise<string | null> | null = null;
const listeners = new Set<(token: string | null) => void>();

export function setAccessToken(token: string | null): void {
  accessToken = token;
  listeners.forEach((fn) => fn(token));
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function onAuthChange(fn: (token: string | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Refreshes the access token using the httpOnly refresh cookie. */
async function refresh(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) return null;
        const data = await res.json();
        setAccessToken(data.accessToken);
        return data.accessToken as string;
      })
      .catch(() => null)
      .finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

/**
 * A stable key for one submission attempt. Mount it with the dialog that creates
 * the record: a double-click or a retried request reuses it and cannot create a
 * duplicate, while a genuinely new submission (a second quotation for the same
 * property, an identical follow-up task next week) gets its own key and is
 * created normally. Deriving the key from the content instead would silently
 * swallow the second one.
 */
export function newRequestId(): string {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `rq-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Retried requests carrying the same key never create a duplicate record. */
  idempotencyKey?: string;
  raw?: boolean;
}

export async function api<T = any>(path: string, options: RequestOptions = {}): Promise<T> {
  const send = async (token: string | null): Promise<Response> => {
    const headers: Record<string, string> = { ...(options.headers as Record<string, string> ?? {}) };
    if (options.body !== undefined && !(options.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    return fetch(`/api${path}`, {
      ...options,
      headers,
      credentials: 'include',
      body: options.body instanceof FormData
        ? options.body
        : options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  };

  let response = await send(accessToken);
  if (response.status === 401 && !path.startsWith('/auth/')) {
    const fresh = await refresh();
    if (fresh) response = await send(fresh);
    else setAccessToken(null);
  }

  if (options.raw) {
    if (!response.ok) throw new ApiError(response.status, await parseError(response));
    return response as unknown as T;
  }

  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(response.status, (data as any).error ?? { code: 'unknown', message: 'Something went wrong.' });
  }
  return data as T;
}

async function parseError(response: Response): Promise<ApiErrorBody> {
  const data = await response.json().catch(() => null);
  return (data as any)?.error ?? { code: 'unknown', message: `Request failed (${response.status}).` };
}

export const get = <T = any>(path: string) => api<T>(path);
export const post = <T = any>(path: string, body?: unknown, opts: RequestOptions = {}) =>
  api<T>(path, { ...opts, method: 'POST', body });
export const patch = <T = any>(path: string, body?: unknown) => api<T>(path, { method: 'PATCH', body });
export const put = <T = any>(path: string, body?: unknown) => api<T>(path, { method: 'PUT', body });
export const del = <T = any>(path: string) => api<T>(path, { method: 'DELETE' });

/** Streams a file the browser should download or open. */
export async function download(path: string, filename?: string): Promise<void> {
  const response = await api<Response>(path, { raw: true });
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  if (filename) link.download = filename;
  else link.target = '_blank';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export async function openInNewTab(path: string): Promise<void> {
  const response = await api<Response>(path, { raw: true });
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export { refresh as refreshSession };
