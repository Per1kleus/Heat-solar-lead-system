import crypto from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Short, sortable-ish, collision-resistant id with an entity prefix. */
export function newId(prefix: string): string {
  const time = Date.now().toString(36).padStart(8, '0');
  const rand = crypto.randomBytes(8);
  let tail = '';
  for (const byte of rand) tail += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${time}${tail}`;
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function slugify(value: string): string {
  const base = value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || 'org';
}
