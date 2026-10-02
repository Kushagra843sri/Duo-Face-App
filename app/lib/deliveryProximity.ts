/**
 * Pure rules for the "mark delivered" gate (docs/decisions/028). This is only
 * the UI hint: the server re-checks with the fresh fix sent at tap time and
 * is the authority. Kept free of React / native modules for testing.
 */
export const DELIVERY_RADIUS_METERS = 50;
/** A fix with a wider error circle cannot prove "within 50 m". */
export const MAX_FIX_ACCURACY_METERS = 50;

export interface Point {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_METERS = 6_371_000;
const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

export function distanceMeters(a: Point, b: Point): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function canMarkDelivered(distance: number | null, accuracyMeters: number | null | undefined): boolean {
  if (distance === null || typeof accuracyMeters !== 'number') return false;
  return distance <= DELIVERY_RADIUS_METERS && accuracyMeters <= MAX_FIX_ACCURACY_METERS;
}

/** Rounded to 10 m so the screen doesn't flicker on every GPS jitter. */
export function describeProximity(distance: number | null, accuracyMeters: number | null | undefined): string {
  if (distance === null) return 'Finding your location…';
  if (typeof accuracyMeters === 'number' && accuracyMeters > MAX_FIX_ACCURACY_METERS) return 'GPS signal is weak. Move to open sky.';
  if (distance <= DELIVERY_RADIUS_METERS) return "You're at the delivery location.";
  const rounded = Math.max(10, Math.round(distance / 10) * 10);
  return `You're about ${rounded} m away. Get within ${DELIVERY_RADIUS_METERS} m to mark delivered.`;
}
