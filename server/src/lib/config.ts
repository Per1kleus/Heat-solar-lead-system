import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '../..');
const dataDir = process.env.VF_DATA_DIR ?? path.join(root, 'data');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'pdf'), { recursive: true });

/** Persist a generated secret so sessions survive a restart in local/dev use. */
function persistentSecret(): string {
  if (process.env.VF_JWT_SECRET) return process.env.VF_JWT_SECRET;
  const file = path.join(dataDir, '.secret');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  if (process.env.NODE_ENV === 'production') {
    console.warn('[config] VF_JWT_SECRET not set — generated one at data/.secret. Set it explicitly in production.');
  }
  return secret;
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: Number(process.env.PORT ?? 4000),
  dataDir,
  uploadsDir: path.join(dataDir, 'uploads'),
  pdfDir: path.join(dataDir, 'pdf'),
  dbPath: process.env.VF_DB_PATH ?? path.join(dataDir, 'voltaflow.db'),
  jwtSecret: persistentSecret(),
  accessTokenTtlMin: 30,
  sessionTtlDays: 30,
  appUrl: process.env.VF_APP_URL ?? 'http://localhost:5173',
  corsOrigins: (process.env.VF_CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:4173').split(','),
  maxUploadBytes: 15 * 1024 * 1024,
  /** Org-level AI key is preferred; this is the fallback for single-tenant installs. */
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: process.env.VF_AI_MODEL ?? 'claude-sonnet-5',
  automationTickMs: Number(process.env.VF_TICK_MS ?? 60_000),
  seedDemoOnBoot: process.env.VF_SEED_DEMO === '1',
};
