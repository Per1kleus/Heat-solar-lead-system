import fs from 'node:fs';
import { config } from '../lib/config.ts';

for (const suffix of ['', '-wal', '-shm']) {
  const p = config.dbPath + suffix;
  if (fs.existsSync(p)) { fs.rmSync(p); console.log('removed', p); }
}
fs.rmSync(config.uploadsDir, { recursive: true, force: true });
fs.rmSync(config.pdfDir, { recursive: true, force: true });
fs.mkdirSync(config.uploadsDir, { recursive: true });
fs.mkdirSync(config.pdfDir, { recursive: true });
console.log('Database reset. Run `npm run db:migrate && npm run db:seed`.');
