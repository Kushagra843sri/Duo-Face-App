import { z } from 'zod';

/**
 * 32-byte key, base64 (generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))").
 * Null = secure storage not configured: profile fields that must be encrypted
 * (PAN, licence, bank account) answer 503 instead of storing plaintext.
 */
export function loadProfileEncryptionKey(source: NodeJS.ProcessEnv = process.env): Buffer | null {
  const raw = source.PROFILE_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, 'base64');
  return key.length === 32 ? key : null;
}

/** Platform commission in basis points (1000 = 10.00%). Unset = not configured (nothing is assumed). */
export function loadCommissionBps(source: NodeJS.ProcessEnv = process.env): number | null {
  const parsed = z.coerce.number().int().min(0).max(10_000).safeParse(source.PLATFORM_COMMISSION_BPS);
  return source.PLATFORM_COMMISSION_BPS?.trim() && parsed.success ? parsed.data : null;
}

const r2Schema = z.object({
  R2_ACCOUNT_ID: z.string().trim().min(1),
  R2_ACCESS_KEY_ID: z.string().trim().min(1),
  R2_SECRET_ACCESS_KEY: z.string().trim().min(1),
  R2_BUCKET: z.string().trim().min(1),
});

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** Null when no R2 bucket is configured: photo endpoints answer 503, the rest of the profile works. */
export function loadR2Config(source: NodeJS.ProcessEnv = process.env): R2Config | null {
  const parsed = r2Schema.safeParse({
    R2_ACCOUNT_ID: source.R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: source.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: source.R2_SECRET_ACCESS_KEY,
    R2_BUCKET: source.R2_BUCKET,
  });
  if (!parsed.success) return null;
  return {
    accountId: parsed.data.R2_ACCOUNT_ID,
    accessKeyId: parsed.data.R2_ACCESS_KEY_ID,
    secretAccessKey: parsed.data.R2_SECRET_ACCESS_KEY,
    bucket: parsed.data.R2_BUCKET,
  };
}
