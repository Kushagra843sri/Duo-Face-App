import { z } from 'zod';

import type { GeocodingConfig } from '../../config/geocoding';

export type GeocodingFailureCategory =
  | 'unavailable' // network error / 5xx
  | 'timeout'
  | 'rate_limited' // 429 / 402 (quota)
  | 'auth' // 401 / 403 — our credentials, an ops problem
  | 'invalid_address' // 400 — provider rejected the query
  | 'no_result'
  | 'low_confidence'
  | 'malformed'
  | 'invalid_coordinates';

/**
 * Carries only a category. Deliberately NOT the provider body, URL or
 * underlying error: request URLs contain the API key and the address.
 */
export class GeocodingError extends Error {
  constructor(readonly category: GeocodingFailureCategory) {
    super(`geocoding failed: ${category}`);
    this.name = 'GeocodingError';
  }
}

export interface ProviderResult {
  latitude: number;
  longitude: number;
  /** Provider-specific precision indicator (OpenCage confidence 1..10). */
  precision: number;
}

export interface GeocodingProvider {
  readonly name: string;
  geocode(address: string): Promise<ProviderResult>;
}

const responseSchema = z.object({
  results: z.array(
    z.object({
      geometry: z.object({ lat: z.unknown(), lng: z.unknown() }),
      confidence: z.number().optional(),
    })
  ),
});

const ENDPOINT = 'https://api.opencagedata.com/geocode/v1/json';

/**
 * OpenCage forward geocoding (docs/decisions/021). Server-side only.
 * `no_record=1` asks OpenCage not to log the query; `limit=1` takes the
 * best match; the API key travels as a query parameter (their only auth
 * method), so the URL must never be logged.
 */
export class OpenCageGeocodingProvider implements GeocodingProvider {
  readonly name = 'opencage';

  constructor(
    private readonly config: GeocodingConfig,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async geocode(address: string): Promise<ProviderResult> {
    const url = new URL(ENDPOINT);
    url.searchParams.set('q', address);
    url.searchParams.set('key', this.config.apiKey);
    url.searchParams.set('limit', '1');
    url.searchParams.set('no_record', '1');
    url.searchParams.set('no_annotations', '1');
    if (this.config.countryCode) url.searchParams.set('countrycode', this.config.countryCode);

    let response: Response;
    try {
      response = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.config.timeoutMs) });
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      throw new GeocodingError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unavailable');
    }

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new GeocodingError('auth');
      if (response.status === 402 || response.status === 429) throw new GeocodingError('rate_limited');
      if (response.status === 400) throw new GeocodingError('invalid_address');
      throw new GeocodingError('unavailable');
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new GeocodingError('malformed');
    }

    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) throw new GeocodingError('malformed');

    const best = parsed.data.results[0];
    if (!best) throw new GeocodingError('no_result');

    const { lat, lng } = best.geometry;
    if (
      typeof lat !== 'number' ||
      typeof lng !== 'number' ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      Math.abs(lat) > 90 ||
      Math.abs(lng) > 180
    ) {
      throw new GeocodingError('invalid_coordinates');
    }

    if (best.confidence === undefined || best.confidence < this.config.minConfidence) {
      throw new GeocodingError('low_confidence');
    }

    return { latitude: lat, longitude: lng, precision: best.confidence };
  }
}
