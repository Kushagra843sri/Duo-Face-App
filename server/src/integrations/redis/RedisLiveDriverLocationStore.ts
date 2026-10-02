import { LiveLocationUnavailableError } from './LiveDriverLocationStore';
import type { LiveDriverLocationStore } from './LiveDriverLocationStore';
import type { LiveDriverLocation } from '../../types/liveDriverLocation';

/**
 * Key layout (docs/decisions/022):
 *
 *   duo_face:drivers:geo               GEO set   member = driverId, (lng, lat)
 *   duo_face:drivers:seen              ZSET      member = driverId, score = last update (ms)
 *   duo_face:drivers:location:<id>     HASH      latitude, longitude, capturedAt (ms),
 *                                                assignmentId, [accuracyMeters, heading, speedMps]
 *                                                — carries the TTL
 *
 * Redis GEO stores no timestamp and its members cannot expire, so the HASH
 * holds the capture time and the TTL, and is the source of truth for
 * "is there a live location". `seen` lets us prune GEO members whose HASH
 * has expired, so the GEO set can't accumulate ghosts.
 */
export const GEO_KEY = 'duo_face:drivers:geo';
export const SEEN_KEY = 'duo_face:drivers:seen';
export const locationKey = (driverId: string) => `duo_face:drivers:location:${driverId}`;

/** The subset of ioredis used here — lets tests inject a command-level fake. */
export interface RedisMulti {
  del(key: string): RedisMulti;
  hset(key: string, fields: Record<string, string>): RedisMulti;
  expire(key: string, seconds: number): RedisMulti;
  geoadd(key: string, longitude: number, latitude: number, member: string): RedisMulti;
  zadd(key: string, score: number, member: string): RedisMulti;
  zrem(key: string, ...members: string[]): RedisMulti;
  exec(): Promise<Array<[Error | null, unknown]> | null>;
}

export interface RedisLike {
  status?: string;
  connect?(): Promise<void>;
  multi(): RedisMulti;
  hgetall(key: string): Promise<Record<string, string>>;
  exists(key: string): Promise<number>;
  zrangebyscore(key: string, min: string | number, max: string | number): Promise<string[]>;
}

const num = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export class RedisLiveDriverLocationStore implements LiveDriverLocationStore {
  constructor(
    private readonly redis: RedisLike,
    /** Expiry of a driver's live position after their last update. */
    private readonly ttlSeconds: number,
    private readonly now: () => number = Date.now
  ) {}

  /** Every failure mode collapses to one non-leaky error. */
  private async guarded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      if (this.redis.status === 'wait' && this.redis.connect) {
        await this.redis.connect(); // lazyConnect: first use opens the connection
      }
      return await operation();
    } catch {
      throw new LiveLocationUnavailableError();
    }
  }

  private async execute(multi: RedisMulti): Promise<void> {
    const results = await multi.exec();
    // exec() resolves (not rejects) with per-command errors; treat any as failure.
    if (!results || results.some(([error]) => error)) throw new Error('redis command failed');
  }

  async update(location: LiveDriverLocation): Promise<void> {
    await this.guarded(async () => {
      const key = locationKey(location.driverId);
      const fields: Record<string, string> = {
        latitude: String(location.latitude),
        longitude: String(location.longitude),
        capturedAt: String(location.capturedAt.getTime()),
        assignmentId: location.assignmentId,
        ...(location.accuracyMeters !== undefined ? { accuracyMeters: String(location.accuracyMeters) } : {}),
        ...(location.heading !== undefined ? { heading: String(location.heading) } : {}),
        ...(location.speedMps !== undefined ? { speedMps: String(location.speedMps) } : {}),
      };

      // MULTI/EXEC: DEL first so optional fields from a previous fix can't linger.
      await this.execute(
        this.redis
          .multi()
          .del(key)
          .hset(key, fields)
          .expire(key, this.ttlSeconds)
          .geoadd(GEO_KEY, location.longitude, location.latitude, location.driverId)
          .zadd(SEEN_KEY, this.now(), location.driverId)
      );

      await this.prune();
    });
  }

  /** Removes GEO/seen members not updated within the TTL (their HASH has already expired). */
  private async prune(): Promise<void> {
    const cutoff = this.now() - this.ttlSeconds * 1000;
    const expired = await this.redis.zrangebyscore(SEEN_KEY, '-inf', cutoff);
    if (expired.length === 0) return;
    await this.execute(this.redis.multi().zrem(GEO_KEY, ...expired).zrem(SEEN_KEY, ...expired));
  }

  async get(driverId: string): Promise<LiveDriverLocation | null> {
    return this.guarded(async () => {
      const hash = await this.redis.hgetall(locationKey(driverId));
      if (!hash || Object.keys(hash).length === 0) return null;

      const latitude = num(hash.latitude);
      const longitude = num(hash.longitude);
      const capturedAtMs = num(hash.capturedAt);
      if (latitude === undefined || longitude === undefined || capturedAtMs === undefined || !hash.assignmentId) {
        return null; // corrupt entry: treat as absent, never expose
      }

      return {
        driverId,
        assignmentId: hash.assignmentId,
        latitude,
        longitude,
        ...(num(hash.accuracyMeters) !== undefined ? { accuracyMeters: num(hash.accuracyMeters) } : {}),
        ...(num(hash.heading) !== undefined ? { heading: num(hash.heading) } : {}),
        ...(num(hash.speedMps) !== undefined ? { speedMps: num(hash.speedMps) } : {}),
        capturedAt: new Date(capturedAtMs),
      };
    });
  }

  async has(driverId: string): Promise<boolean> {
    return this.guarded(async () => (await this.redis.exists(locationKey(driverId))) === 1);
  }

  async remove(driverId: string): Promise<void> {
    await this.guarded(async () => {
      await this.execute(this.redis.multi().del(locationKey(driverId)).zrem(GEO_KEY, driverId).zrem(SEEN_KEY, driverId));
    });
  }
}
