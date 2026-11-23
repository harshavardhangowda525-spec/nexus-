import crypto from 'node:crypto';

/** AES-256-GCM envelope for secrets at rest: base64(iv | tag | ciphertext). */
export class SecretBox {
  private key: Buffer;
  constructor(masterKeyB64: string) {
    const key = Buffer.from(masterKeyB64 || '', 'base64');
    if (key.length !== 32) throw new Error('NEXUS_MASTER_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
    this.key = key;
  }
  seal(plain: string): string {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }
  open(sealed: string): string {
    const buf = Buffer.from(sealed, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
  }
}

export function hint(secret: string) {
  return secret.length <= 8 ? '••••' : `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

export function sha256(s: string | Buffer) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

const SCRYPT = { N: 16384, r: 8, p: 1 };
export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(pw, salt, 32, SCRYPT);
  return ['scrypt', salt.toString('base64'), dk.toString('base64')].join('$');
}
export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, s, h] = stored.split('$');
  if (alg !== 'scrypt' || !s || !h) return false;
  const dk = crypto.scryptSync(pw, Buffer.from(s, 'base64'), 32, SCRYPT);
  const want = Buffer.from(h, 'base64');
  return want.length === dk.length && crypto.timingSafeEqual(want, dk);
}
