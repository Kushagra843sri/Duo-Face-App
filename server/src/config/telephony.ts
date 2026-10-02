import { z } from 'zod';

const exotelSchema = z.object({
  EXOTEL_ACCOUNT_SID: z.string().trim().min(1),
  EXOTEL_API_KEY: z.string().trim().min(1),
  EXOTEL_API_TOKEN: z.string().trim().min(1),
  // Mumbai cluster by default (India); Singapore is api.exotel.com.
  EXOTEL_SUBDOMAIN: z
    .string()
    .trim()
    .regex(/^[a-z0-9.-]+\.exotel\.com$/i)
    .default('api.in.exotel.com'),
  // The ExoPhone (virtual number) the customer sees.
  EXOTEL_CALLER_ID: z.string().trim().min(1),
  // Public HTTPS origin of this server, for Exotel's status callback.
  PUBLIC_BASE_URL: z.string().trim().url(),
  // Signs the callback URL token (Exotel documents no callback signature).
  CALL_WEBHOOK_SECRET: z.string().trim().min(16),
});

export interface ExotelCallConfig {
  accountSid: string;
  apiKey: string;
  apiToken: string;
  host: string;
  callerId: string;
  publicBaseUrl: string;
  webhookSecret: string;
}

/** Null when masked calling is not configured (calls answer 503; nothing is attempted). */
export function loadExotelCallConfig(source: NodeJS.ProcessEnv = process.env): ExotelCallConfig | null {
  const parsed = exotelSchema.safeParse({
    EXOTEL_ACCOUNT_SID: source.EXOTEL_ACCOUNT_SID,
    EXOTEL_API_KEY: source.EXOTEL_API_KEY,
    EXOTEL_API_TOKEN: source.EXOTEL_API_TOKEN,
    EXOTEL_SUBDOMAIN: source.EXOTEL_SUBDOMAIN || undefined,
    EXOTEL_CALLER_ID: source.EXOTEL_CALLER_ID,
    PUBLIC_BASE_URL: source.PUBLIC_BASE_URL,
    CALL_WEBHOOK_SECRET: source.CALL_WEBHOOK_SECRET,
  });
  if (!parsed.success) return null;
  const c = parsed.data;
  return {
    accountSid: c.EXOTEL_ACCOUNT_SID,
    apiKey: c.EXOTEL_API_KEY,
    apiToken: c.EXOTEL_API_TOKEN,
    host: c.EXOTEL_SUBDOMAIN,
    callerId: c.EXOTEL_CALLER_ID,
    publicBaseUrl: c.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    webhookSecret: c.CALL_WEBHOOK_SECRET,
  };
}

const otpSchema = z.object({
  // HMAC key for the delivery code. A 6-digit code has only 1e6 values, so a
  // bare hash would be trivially reversible if a document leaked.
  DELIVERY_OTP_SECRET: z.string().trim().min(16),
});

/** Null disables the delivery-code fallback entirely (no code is generated or sent). */
export function loadDeliveryOtpSecret(source: NodeJS.ProcessEnv = process.env): string | null {
  const parsed = otpSchema.safeParse({ DELIVERY_OTP_SECRET: source.DELIVERY_OTP_SECRET });
  return parsed.success ? parsed.data.DELIVERY_OTP_SECRET : null;
}

const smsSchema = z.object({
  EXOTEL_SMS_SENDER: z.string().trim().min(1),
  EXOTEL_DLT_ENTITY_ID: z.string().trim().min(1),
  EXOTEL_DLT_TEMPLATE_ID: z.string().trim().min(1),
  // Must match the DLT-approved template text exactly; {code} is replaced.
  EXOTEL_SMS_TEMPLATE: z.string().trim().min(1).refine((t) => t.includes('{code}'), 'template must contain {code}'),
});

export interface ExotelSmsConfig {
  sender: string;
  dltEntityId: string;
  dltTemplateId: string;
  template: string;
}

/** Null when the delivery-code SMS is not configured (needs DLT registration in India). */
export function loadExotelSmsConfig(source: NodeJS.ProcessEnv = process.env): ExotelSmsConfig | null {
  const parsed = smsSchema.safeParse({
    EXOTEL_SMS_SENDER: source.EXOTEL_SMS_SENDER,
    EXOTEL_DLT_ENTITY_ID: source.EXOTEL_DLT_ENTITY_ID,
    EXOTEL_DLT_TEMPLATE_ID: source.EXOTEL_DLT_TEMPLATE_ID,
    EXOTEL_SMS_TEMPLATE: source.EXOTEL_SMS_TEMPLATE,
  });
  if (!parsed.success) return null;
  return {
    sender: parsed.data.EXOTEL_SMS_SENDER,
    dltEntityId: parsed.data.EXOTEL_DLT_ENTITY_ID,
    dltTemplateId: parsed.data.EXOTEL_DLT_TEMPLATE_ID,
    template: parsed.data.EXOTEL_SMS_TEMPLATE,
  };
}
