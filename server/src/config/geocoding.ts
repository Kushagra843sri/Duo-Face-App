import { z } from 'zod';

const geocodingEnvSchema = z.object({
  OPENCAGE_API_KEY: z.string().trim().min(1),
  GEOCODER_COUNTRY_CODE: z
    .string()
    .trim()
    .regex(/^[a-zA-Z]{2}$/)
    .optional(),
  // OpenCage confidence is 1..10 (10 = within ~0.25 km, 7 = within ~5 km).
  GEOCODER_MIN_CONFIDENCE: z.coerce.number().int().min(1).max(10).default(7),
  GEOCODER_TIMEOUT_MS: z.coerce.number().int().min(500).max(30000).default(5000),
});

export interface GeocodingConfig {
  apiKey: string;
  countryCode?: string;
  minConfidence: number;
  timeoutMs: number;
}

/**
 * Returns null when geocoding is not configured (no OPENCAGE_API_KEY) —
 * the caller then runs without geocoding; nothing throws and no fake
 * coordinates are produced. A present-but-malformed optional setting also
 * yields null (safe off) rather than crashing the server.
 */
export function loadGeocodingConfig(source: NodeJS.ProcessEnv = process.env): GeocodingConfig | null {
  const parsed = geocodingEnvSchema.safeParse({
    OPENCAGE_API_KEY: source.OPENCAGE_API_KEY,
    GEOCODER_COUNTRY_CODE: source.GEOCODER_COUNTRY_CODE || undefined,
    GEOCODER_MIN_CONFIDENCE: source.GEOCODER_MIN_CONFIDENCE || undefined,
    GEOCODER_TIMEOUT_MS: source.GEOCODER_TIMEOUT_MS || undefined,
  });
  if (!parsed.success) return null;

  return {
    apiKey: parsed.data.OPENCAGE_API_KEY,
    countryCode: parsed.data.GEOCODER_COUNTRY_CODE?.toLowerCase(),
    minConfidence: parsed.data.GEOCODER_MIN_CONFIDENCE,
    timeoutMs: parsed.data.GEOCODER_TIMEOUT_MS,
  };
}
