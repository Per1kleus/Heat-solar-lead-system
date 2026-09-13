import { insert } from './db.ts';
import { newId } from './ids.ts';
import { nowIso } from './time.ts';

export interface AuditInput {
  orgId: string;
  userId?: string | null;
  actorLabel?: string;
  action: string;
  entityType: string;
  entityId?: string | null;
  entityLabel?: string | null;
  changes?: Record<string, unknown>;
  ip?: string | null;
}

export function audit(input: AuditInput): void {
  insert('audit_logs', {
    id: newId('aud'),
    org_id: input.orgId,
    user_id: input.userId ?? null,
    actor_label: input.actorLabel ?? (input.userId ? 'user' : 'system'),
    action: input.action,
    entity_type: input.entityType,
    entity_id: input.entityId ?? null,
    entity_label: input.entityLabel ?? null,
    changes: JSON.stringify(input.changes ?? {}),
    ip: input.ip ?? null,
    created_at: nowIso(),
  });
}

/** Shallow diff limited to keys that actually changed — keeps the audit log readable. */
export function diff(before: Record<string, any>, after: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(after)) {
    if (after[key] === undefined) continue;
    const b = before[key] ?? null;
    const a = after[key] ?? null;
    if (JSON.stringify(b) !== JSON.stringify(a)) out[key] = { from: b, to: a };
  }
  return out;
}
