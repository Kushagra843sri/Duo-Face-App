import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const VERSION = 'v1';

/** Secure storage is not configured: callers answer 503 and never fall back to plaintext. */
export class SecureStorageUnavailableError extends Error {
  constructor() {
    super('secure storage unavailable');
    this.name = 'SecureStorageUnavailableError';
  }
}

/**
 * AES-256-GCM field encryption for the few values we must be able to read back
 * server-side (PAN, licence number, bank account number) but never expose
 * (docs/decisions/029). Each value gets a fresh random nonce, and a context
 * string (e.g. "driver:<id>:pan") is bound as authenticated data so a
 * ciphertext cannot be copied to another field or another person's record.
 *
 * Envelope: `v1:<nonce>:<ciphertext>:<tag>` (base64url). The version prefix
 * allows key rotation later (decrypt by version, re-encrypt on write).
 */
export class FieldCrypto {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('FieldCrypto needs a 32-byte key');
  }

  encrypt(plaintext: string, context: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(Buffer.from(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, nonce.toString('base64url'), ciphertext.toString('base64url'), tag.toString('base64url')].join(':');
  }

  /** Throws on a wrong key, wrong context or any tampering. */
  decrypt(envelope: string, context: string): string {
    const [version, nonce, ciphertext, tag] = envelope.split(':');
    if (version !== VERSION || !nonce || !ciphertext || !tag) throw new Error('unsupported ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(nonce, 'base64url'));
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  }
}

/** Last `n` characters, for masked display ("••••5678"). */
export const lastChars = (value: string, n = 4) => value.slice(-n);
export const maskLast = (value: string, visible = 4) => `${'•'.repeat(Math.max(0, value.length - visible))}${value.slice(-visible)}`;
