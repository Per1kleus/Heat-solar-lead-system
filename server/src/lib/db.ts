import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';

export const db = new DatabaseSync(config.dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');
db.exec('PRAGMA synchronous = NORMAL');

export function applySchema(): void {
  const schemaPath = path.join(import.meta.dirname, '../db/schema.sql');
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
}

export type Row = Record<string, any>;

export function all<T = Row>(sql: string, params: any[] = []): T[] {
  return db.prepare(sql).all(...normalize(params)) as T[];
}

export function get<T = Row>(sql: string, params: any[] = []): T | undefined {
  return db.prepare(sql).get(...normalize(params)) as T | undefined;
}

export function run(sql: string, params: any[] = []) {
  return db.prepare(sql).run(...normalize(params));
}

/** node:sqlite only binds null/number/string/bigint/Uint8Array. */
function normalize(params: any[]): any[] {
  return params.map((p) => {
    if (p === undefined || p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    if (typeof p === 'object' && !(p instanceof Uint8Array)) return JSON.stringify(p);
    return p;
  });
}

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/**
 * Build an INSERT from a plain object. Keys are validated against a strict
 * identifier pattern so callers can never inject column names.
 */
export function insert(table: string, data: Row): void {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  assertIdent(table);
  keys.forEach(assertIdent);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  run(sql, keys.map((k) => data[k]));
}

export function update(table: string, id: string, orgId: string, data: Row): void {
  const keys = Object.keys(data).filter((k) => data[k] !== undefined);
  if (keys.length === 0) return;
  assertIdent(table);
  keys.forEach(assertIdent);
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND org_id = ?`;
  run(sql, [...keys.map((k) => data[k]), id, orgId]);
}

const IDENT = /^[a-z_][a-z0-9_]*$/i;
function assertIdent(value: string): void {
  if (!IDENT.test(value)) throw new Error(`Unsafe SQL identifier: ${value}`);
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

export function bool(value: unknown): boolean {
  return value === 1 || value === true || value === '1';
}
