import { applySchema, db, get, run } from '../lib/db.ts';
import { nowIso } from '../lib/time.ts';

applySchema();
const existing = get<{ value: string }>('SELECT value FROM schema_meta WHERE key = ?', ['version']);
if (!existing) {
  run('INSERT INTO schema_meta (key, value) VALUES (?, ?)', ['version', '1']);
  run('INSERT INTO schema_meta (key, value) VALUES (?, ?)', ['migrated_at', nowIso()]);
}
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
console.log(`Schema applied — ${tables.length} tables:`);
console.log(tables.map((t) => `  • ${t.name}`).join('\n'));
