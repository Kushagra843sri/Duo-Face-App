import Redis from 'ioredis';

import { loadRedisUrl } from '../../config/redis';
import { UnavailableLiveDriverLocationStore } from './LiveDriverLocationStore';
import type { LiveDriverLocationStore } from './LiveDriverLocationStore';
import { RedisLiveDriverLocationStore } from './RedisLiveDriverLocationStore';
import type { RedisLike } from './RedisLiveDriverLocationStore';

/**
 * TTL of a driver's live position after their last update: 5 minutes.
 * Long enough to ride out brief signal loss / app switching without the
 * position vanishing; short enough that a crashed or closed app's marker
 * disappears on its own. This is NOT the freshness threshold (60 s, see
 * services/locationFreshness.ts): a position between 60 s and 5 min old is
 * still stored but reported "stale".
 */
export const LIVE_LOCATION_TTL_SECONDS = 300;

/**
 * Composition root. Without REDIS_URL the server runs normally and
 * tracking answers 503. The client never crashes the process: errors are
 * swallowed here (logged as a category only, never the URL), commands fail
 * fast rather than queueing, and reconnection is left to ioredis.
 */
export function createLiveDriverLocationStore(source: NodeJS.ProcessEnv = process.env): LiveDriverLocationStore {
  const url = loadRedisUrl(source);
  if (!url) return new UnavailableLiveDriverLocationStore();

  const client = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false, // fail fast while disconnected instead of buffering GPS pings
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 2000,
  });
  client.on('error', () => {
    console.warn('Redis: connection error');
  });

  return new RedisLiveDriverLocationStore(client as unknown as RedisLike, LIVE_LOCATION_TTL_SECONDS);
}
