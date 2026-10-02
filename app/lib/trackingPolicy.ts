import type { DriverAssignment } from '@/api/driver';

/**
 * UI hint only — the server (services/trackingPolicy.ts) is the authority
 * and re-checks on every publish. Mirrors accepted / picked_up.
 */
const TRACKING_STATUSES: ReadonlyArray<DriverAssignment['status']> = ['accepted', 'picked_up'];

export function canStartTracking(status: DriverAssignment['status']): boolean {
  return TRACKING_STATUSES.includes(status);
}

/**
 * Conservative cadence (battery + server limits):
 * - the OS delivers a fix at most every 25 m moved and (Android) 10 s,
 * - we additionally send at most one update per MIN_SEND_INTERVAL_MS even
 *   if a platform ignores timeInterval,
 * - fixes worse than MAX_ACCURACY_METERS are skipped (a 500 m-radius fix is
 *   noise, and shouldn't move a marker),
 * so at most 6 updates/min — half the server's 12/min limit.
 * Freshness is NOT computed here: the server decides fresh/stale.
 */
export const MIN_SEND_INTERVAL_MS = 10_000;
export const MAX_ACCURACY_METERS = 100;

export function shouldSendFix(
  fix: { accuracy?: number | null },
  lastSentAt: number | null,
  now: number
): boolean {
  if (typeof fix.accuracy === 'number' && fix.accuracy > MAX_ACCURACY_METERS) return false;
  if (lastSentAt !== null && now - lastSentAt < MIN_SEND_INTERVAL_MS) return false;
  return true;
}
