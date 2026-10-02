export interface Coordinate {
  latitude: number;
  longitude: number;
}

export interface MapRegion extends Coordinate {
  latitudeDelta: number;
  longitudeDelta: number;
}

export function isValidCoordinate(point: Partial<Coordinate> | null | undefined): point is Coordinate {
  return (
    !!point &&
    typeof point.latitude === 'number' &&
    typeof point.longitude === 'number' &&
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.latitude) <= 90 &&
    Math.abs(point.longitude) <= 180
  );
}

/**
 * External-navigation handoff (no in-app turn-by-turn). Google's documented
 * universal "Maps URLs" form: opens the Maps app on iOS/Android, the website
 * elsewhere, and needs no API key. Returns null when there is no valid
 * destination — a URL is never built from missing/fake coordinates.
 */
export function buildNavigationUrl(destination: Partial<Coordinate> | null | undefined): string | null {
  if (!isValidCoordinate(destination)) return null;
  return `https://www.google.com/maps/dir/?api=1&destination=${destination.latitude},${destination.longitude}&travelmode=driving`;
}

const MIN_DELTA = 0.01; // roughly 1 km, so a single point (or two very close ones) isn't zoomed absurdly far in
const PADDING = 1.6;

/** A region covering all valid points, padded; null when there are none. */
export function computeMapRegion(points: Array<Partial<Coordinate> | null | undefined>): MapRegion | null {
  const valid = points.filter(isValidCoordinate);
  if (valid.length === 0) return null;

  const lats = valid.map((p) => p.latitude);
  const lngs = valid.map((p) => p.longitude);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);

  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLng + maxLng) / 2,
    latitudeDelta: Math.max((maxLat - minLat) * PADDING, MIN_DELTA),
    longitudeDelta: Math.max((maxLng - minLng) * PADDING, MIN_DELTA),
  };
}

export function formatAge(capturedAtIso: string, now: Date = new Date()): string {
  const seconds = Math.max(0, Math.round((now.getTime() - new Date(capturedAtIso).getTime()) / 1000));
  if (Number.isNaN(seconds)) return 'unknown time ago';
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export interface DriverLocationLike extends Coordinate {
  capturedAt: string | null;
  /** Server-computed (Phase 18's getLocationFreshness) — not reimplemented here. */
  freshness: 'fresh' | 'stale';
}

export interface DriverLocationStatus {
  /** Only a fresh location may be plotted as "current". */
  point: Coordinate | null;
  text: string;
}

export function describeDriverLocation(
  location: DriverLocationLike | null,
  permissionDenied: boolean,
  now: Date = new Date()
): DriverLocationStatus {
  if (!location) {
    return {
      point: null,
      text: permissionDenied
        ? 'Current location unavailable — location permission is denied.'
        : 'Current location unavailable — update it from the Location tab.',
    };
  }
  const age = location.capturedAt ? formatAge(location.capturedAt, now) : 'at an unknown time';
  if (location.freshness === 'stale') {
    return { point: null, text: `Location stale — last updated ${age}. Update it from the Location tab.` };
  }
  return { point: location, text: `Location last updated ${age}.` };
}
