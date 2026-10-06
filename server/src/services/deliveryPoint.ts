import type { GeoPoint } from './geo';

/**
 * The GPS point a customer saved with their delivery address, if it is a
 * real coordinate. Preferred over any geocoder: it is exact, free, and what
 * the customer actually pointed at. Anything not a finite in-range number
 * is ignored (never guessed or repaired).
 */
export function savedDeliveryPoint(delivery: { latitude?: unknown; longitude?: unknown } | null | undefined): GeoPoint | null {
  const lat = delivery?.latitude;
  const lng = delivery?.longitude;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { latitude: lat, longitude: lng };
}
