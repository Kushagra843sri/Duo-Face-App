import { z } from 'zod';

const otpSchema = z.object({
  // HMAC key for the delivery code. A 6-digit code has only 1e6 values, so a
  // bare hash would be trivially reversible if a document leaked.
  DELIVERY_OTP_SECRET: z.string().trim().min(16),
});

/** Null disables the delivery-code fallback entirely (no code is generated). */
export function loadDeliveryOtpSecret(source: NodeJS.ProcessEnv = process.env): string | null {
  const parsed = otpSchema.safeParse({ DELIVERY_OTP_SECRET: source.DELIVERY_OTP_SECRET });
  return parsed.success ? parsed.data.DELIVERY_OTP_SECRET : null;
}
