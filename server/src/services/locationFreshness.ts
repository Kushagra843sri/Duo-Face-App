export type LocationFreshness = 'fresh' | 'stale';

/**
 * A manually-sent (durable, Firestore) location older than this is
 * "stale". 5 minutes, deliberately generous: manual updates are rare.
 * Live tracking uses the tighter LIVE_LOCATION_STALE_AFTER_MS below.
 */
export const LOCATION_STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * Dispatch window for an ON-DUTY driver: 10 minutes. The app sends a fix every
 * minute (Android); iOS only reports as the phone moves, so a stationary but
 * on-duty driver may legitimately go quiet. Twice the 5-minute manual window
 * keeps them eligible without offering orders to someone who vanished.
 */
export const DUTY_LOCATION_STALE_AFTER_MS = 10 * 60 * 1000;

/**
 * Live tracking threshold: 60 s. Driven by the mobile cadence (a fix at
 * least every ~10 s while moving), so 60 s = several missed updates. A
 * stationary iOS driver may legitimately go "stale" (updates are
 * distance-triggered) — stale means "not recently updated", not "gone".
 * The Redis TTL (5 min, integrations/redis) is a separate, longer concept:
 * when the entry is deleted entirely. Freshness is always computed here,
 * on the server; the mobile app only displays it.
 */
export const LIVE_LOCATION_STALE_AFTER_MS = 60 * 1000;

/**
 * Pure: no clock access. A capture time in the future (clock skew) counts
 * as fresh; an unparseable one counts as stale.
 */
export function getLocationFreshness(
  capturedAt: Date | null,
  now: Date,
  staleAfterMs: number = LOCATION_STALE_AFTER_MS
): LocationFreshness {
  if (!capturedAt || Number.isNaN(capturedAt.getTime())) return 'stale';
  return now.getTime() - capturedAt.getTime() > staleAfterMs ? 'stale' : 'fresh';
}
