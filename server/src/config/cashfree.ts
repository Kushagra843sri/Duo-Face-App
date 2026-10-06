import { z } from 'zod';

const schema = z.object({
  CASHFREE_APP_ID: z.string().trim().min(1),
  CASHFREE_SECRET_KEY: z.string().trim().min(1),
  CASHFREE_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  PUBLIC_BASE_URL: z.string().trim().url(),
});

export interface CashfreeConfig {
  appId: string;
  secretKey: string;
  env: 'sandbox' | 'production';
  /** Public origin of this server, no trailing slash: checkout page, return page and webhook live under it. */
  publicBaseUrl: string;
}

/** How long an unpaid online order keeps its stock reserved. */
export const PAYMENT_HOLD_MINUTES = 15;

/**
 * Null when online payment is not configured: online checkout answers 503 and
 * the app only offers cash on delivery. Nothing is guessed or defaulted except
 * the sandbox environment (the safe one).
 */
export function loadCashfreeConfig(source: NodeJS.ProcessEnv = process.env): CashfreeConfig | null {
  const parsed = schema.safeParse({
    CASHFREE_APP_ID: source.CASHFREE_APP_ID,
    CASHFREE_SECRET_KEY: source.CASHFREE_SECRET_KEY,
    CASHFREE_ENV: source.CASHFREE_ENV?.trim() || undefined,
    PUBLIC_BASE_URL: source.PUBLIC_BASE_URL,
  });
  if (!parsed.success) return null;
  return {
    appId: parsed.data.CASHFREE_APP_ID,
    secretKey: parsed.data.CASHFREE_SECRET_KEY,
    env: parsed.data.CASHFREE_ENV,
    publicBaseUrl: parsed.data.PUBLIC_BASE_URL.replace(/\/+$/, ''),
  };
}
