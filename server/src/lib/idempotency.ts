import { get, insert } from './db.ts';
import { nowIso } from './time.ts';

/**
 * Replay protection for create endpoints. A retried request carrying the same
 * Idempotency-Key returns the original response instead of creating a duplicate
 * lead / task / quotation.
 */
export function readIdempotent<T>(orgId: string, key: string | undefined): T | null {
  if (!key) return null;
  const row = get<{ response: string }>('SELECT response FROM idempotency_keys WHERE id = ?', [`${orgId}:${key}`]);
  return row ? (JSON.parse(row.response) as T) : null;
}

export function writeIdempotent(orgId: string, key: string | undefined, endpoint: string, response: unknown): void {
  if (!key) return;
  try {
    insert('idempotency_keys', {
      id: `${orgId}:${key}`,
      org_id: orgId,
      key,
      endpoint,
      response: JSON.stringify(response),
      created_at: nowIso(),
    });
  } catch {
    // A concurrent request already stored the result — nothing to do.
  }
}
