export interface GeoPoint {
  latitude: number;
  longitude: number;
}

const EARTH_RADIUS_METERS = 6_371_000;

const toRadians = (degrees: number) => (degrees * Math.PI) / 180;

/** Great-circle distance. Accurate enough for ranking drivers within a city. */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLng = toRadians(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(a.latitude)) * Math.cos(toRadians(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Nearest-first. Ties break on driverId so the choice is deterministic
 * (two drivers at the same spot never flip between requests).
 */
export function rankByDistance<T extends { driverId: string; location: GeoPoint }>(
  origin: GeoPoint,
  candidates: T[]
): Array<T & { distanceMeters: number }> {
  return candidates
    .map((candidate) => ({ ...candidate, distanceMeters: haversineMeters(origin, candidate.location) }))
    .sort((a, b) => a.distanceMeters - b.distanceMeters || a.driverId.localeCompare(b.driverId));
}
