import { loadRedisUrl } from '../../src/config/redis';
import {
  InMemoryLiveDriverLocationStore,
  LiveLocationUnavailableError,
  UnavailableLiveDriverLocationStore,
} from '../../src/integrations/redis/LiveDriverLocationStore';
import {
  GEO_KEY,
  RedisLiveDriverLocationStore,
  SEEN_KEY,
  locationKey,
} from '../../src/integrations/redis/RedisLiveDriverLocationStore';
import type { RedisLike, RedisMulti } from '../../src/integrations/redis/RedisLiveDriverLocationStore';
import type { LiveDriverLocation } from '../../src/types/liveDriverLocation';

/**
 * A command-level FAKE of the ioredis subset the store uses. It checks that
 * the store issues the intended command sequence and reads values back
 * correctly; it is NOT a Redis server, so real Redis semantics/connectivity
 * remain unverified (see docs/decisions/022).
 */
class FakeRedis implements RedisLike {
  status: string | undefined;
  hashes = new Map<string, { fields: Record<string, string>; expiresAt?: number }>();
  geo = new Map<string, Map<string, [number, number]>>();
  zsets = new Map<string, Map<string, number>>();
  failNext: 'exec-throw' | 'exec-error' | 'exec-null' | 'read' | null = null;
  connectCalls = 0;
  connectShouldFail = false;

  constructor(public clock: { now: number }, status?: string) {
    this.status = status;
  }

  async connect() {
    this.connectCalls++;
    if (this.connectShouldFail) throw new Error('ECONNREFUSED');
    this.status = 'ready';
  }

  private liveHash(key: string) {
    const entry = this.hashes.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= this.clock.now) {
      this.hashes.delete(key);
      return undefined;
    }
    return entry;
  }

  multi(): RedisMulti {
    const ops: Array<() => void> = [];
    const chain: RedisMulti = {
      del: (key) => (ops.push(() => void this.hashes.delete(key)), chain),
      hset: (key, fields) => (ops.push(() => void this.hashes.set(key, { fields: { ...fields } })), chain),
      expire: (key, seconds) =>
        (ops.push(() => {
          const entry = this.hashes.get(key);
          if (entry) entry.expiresAt = this.clock.now + seconds * 1000;
        }),
        chain),
      geoadd: (key, lng, lat, member) =>
        (ops.push(() => {
          const set = this.geo.get(key) ?? new Map();
          set.set(member, [lng, lat]);
          this.geo.set(key, set);
        }),
        chain),
      zadd: (key, score, member) =>
        (ops.push(() => {
          const z = this.zsets.get(key) ?? new Map();
          z.set(member, score);
          this.zsets.set(key, z);
        }),
        chain),
      zrem: (key, ...members) =>
        (ops.push(() => {
          for (const m of members) {
            this.geo.get(key)?.delete(m);
            this.zsets.get(key)?.delete(m);
          }
        }),
        chain),
      exec: async () => {
        const failure = this.failNext;
        if (failure === 'exec-throw') {
          this.failNext = null;
          throw new Error('Command timed out');
        }
        if (failure === 'exec-null') {
          this.failNext = null;
          return null;
        }
        if (failure === 'exec-error') {
          this.failNext = null;
          return [[new Error('OOM'), null]];
        }
        ops.forEach((op) => op());
        return ops.map(() => [null, 'OK'] as [null, string]);
      },
    };
    return chain;
  }

  async hgetall(key: string) {
    if (this.failNext === 'read') {
      this.failNext = null;
      throw new Error('read failed');
    }
    return this.liveHash(key)?.fields ?? {};
  }

  async exists(key: string) {
    return this.liveHash(key) ? 1 : 0;
  }

  async zrangebyscore(key: string, _min: string | number, max: string | number) {
    const z = this.zsets.get(key) ?? new Map();
    return [...z.entries()].filter(([, score]) => score <= Number(max)).map(([member]) => member);
  }
}

const T0 = new Date('2026-01-01T12:00:00Z').getTime();

function live(overrides: Partial<LiveDriverLocation> = {}): LiveDriverLocation {
  return {
    driverId: 'driver-1',
    assignmentId: 'assignment-1',
    latitude: 28.6139,
    longitude: 77.209,
    accuracyMeters: 10,
    heading: 180,
    speedMps: 5,
    capturedAt: new Date(T0),
    ...overrides,
  };
}

describe('RedisLiveDriverLocationStore (against a command-level fake)', () => {
  function setup(status?: string) {
    const clock = { now: T0 };
    const redis = new FakeRedis(clock, status);
    const store = new RedisLiveDriverLocationStore(redis, 300, () => clock.now);
    return { clock, redis, store };
  }

  it('writes then reads a location', async () => {
    const { store } = setup();
    await store.update(live());
    expect(await store.get('driver-1')).toEqual(live());
    expect(await store.has('driver-1')).toBe(true);
  });

  it('uses the documented keys: GEO(lng,lat) + seen zset + per-driver hash', async () => {
    const { store, redis } = setup();
    await store.update(live());
    expect(locationKey('driver-1')).toBe('duo_face:drivers:location:driver-1');
    expect(redis.geo.get(GEO_KEY)!.get('driver-1')).toEqual([77.209, 28.6139]); // longitude first
    expect(redis.zsets.get(SEEN_KEY)!.get('driver-1')).toBe(T0);
    expect(Object.keys(redis.hashes.get(locationKey('driver-1'))!.fields).sort()).toEqual(
      ['accuracyMeters', 'assignmentId', 'capturedAt', 'heading', 'latitude', 'longitude', 'speedMps']
    );
  });

  it('never keys or stores anything by Firebase UID, customer or order data', async () => {
    const { store, redis } = setup();
    await store.update(live());
    const everything = JSON.stringify([...redis.hashes.entries(), ...redis.geo.entries(), ...redis.zsets.entries()]);
    expect(everything).not.toMatch(/uid|customer|address|phone|payment|order/i);
  });

  it('overwrites the previous location and drops stale optional fields', async () => {
    const { store } = setup();
    await store.update(live());
    await store.update(live({ latitude: 1, longitude: 2, accuracyMeters: undefined, heading: undefined, speedMps: undefined }));
    const got = await store.get('driver-1');
    expect(got).toMatchObject({ latitude: 1, longitude: 2 });
    expect(got!.heading).toBeUndefined();
    expect(got!.speedMps).toBeUndefined();
  });

  it('sets a TTL: the location disappears after the TTL, refreshed by each update', async () => {
    const { store, clock } = setup();
    await store.update(live());
    clock.now = T0 + 299_000;
    expect(await store.get('driver-1')).not.toBeNull();
    await store.update(live()); // refresh
    clock.now = T0 + 299_000 + 299_000;
    expect(await store.get('driver-1')).not.toBeNull();
    clock.now = T0 + 299_000 + 301_000;
    expect(await store.get('driver-1')).toBeNull();
    expect(await store.has('driver-1')).toBe(false);
  });

  it('prunes GEO/seen members whose TTL has passed, so ghosts do not accumulate', async () => {
    const { store, clock, redis } = setup();
    await store.update(live({ driverId: 'driver-old' }));
    clock.now = T0 + 301_000;
    await store.update(live({ driverId: 'driver-new' }));

    expect(redis.geo.get(GEO_KEY)!.has('driver-old')).toBe(false);
    expect(redis.zsets.get(SEEN_KEY)!.has('driver-old')).toBe(false);
    expect(redis.geo.get(GEO_KEY)!.has('driver-new')).toBe(true);
  });

  it('returns null for a missing driver and for a corrupt entry (never exposed)', async () => {
    const { store, redis } = setup();
    expect(await store.get('nobody')).toBeNull();
    redis.hashes.set(locationKey('driver-1'), { fields: { latitude: 'abc', longitude: '1', capturedAt: '1', assignmentId: 'a' } });
    expect(await store.get('driver-1')).toBeNull();
  });

  it('remove deletes the hash and the GEO/seen membership', async () => {
    const { store, redis } = setup();
    await store.update(live());
    await store.remove('driver-1');
    expect(await store.get('driver-1')).toBeNull();
    expect(redis.geo.get(GEO_KEY)!.has('driver-1')).toBe(false);
    expect(redis.zsets.get(SEEN_KEY)!.has('driver-1')).toBe(false);
  });

  it.each(['exec-throw', 'exec-error', 'exec-null'] as const)('write failure (%s) -> LiveLocationUnavailableError', async (mode) => {
    const { store, redis } = setup();
    redis.failNext = mode;
    await expect(store.update(live())).rejects.toBeInstanceOf(LiveLocationUnavailableError);
  });

  it('read failure -> LiveLocationUnavailableError, without leaking the underlying message', async () => {
    const { store, redis } = setup();
    redis.failNext = 'read';
    const error = await store.get('driver-1').catch((e: Error) => e);
    expect(error).toBeInstanceOf(LiveLocationUnavailableError);
    expect((error as Error).message).not.toContain('read failed');
  });

  it('lazily connects on first use (status "wait") and reports an unreachable Redis as unavailable', async () => {
    const ok = setup('wait');
    await ok.store.update(live());
    expect(ok.redis.connectCalls).toBe(1);

    const down = setup('wait');
    down.redis.connectShouldFail = true;
    await expect(down.store.get('driver-1')).rejects.toBeInstanceOf(LiveLocationUnavailableError);
  });
});

describe('InMemoryLiveDriverLocationStore', () => {
  it('has Redis-equivalent TTL semantics for tests', async () => {
    let now = T0;
    const store = new InMemoryLiveDriverLocationStore(300_000, () => now);
    await store.update(live());
    expect(await store.get('driver-1')).toEqual(live());
    now = T0 + 300_001;
    expect(await store.get('driver-1')).toBeNull();
    expect(await store.has('driver-1')).toBe(false);
  });
});

describe('UnavailableLiveDriverLocationStore / config', () => {
  it('every operation is a controlled unavailable', async () => {
    const store = new UnavailableLiveDriverLocationStore();
    await expect(store.update()).rejects.toBeInstanceOf(LiveLocationUnavailableError);
    await expect(store.get()).rejects.toBeInstanceOf(LiveLocationUnavailableError);
    await expect(store.has()).rejects.toBeInstanceOf(LiveLocationUnavailableError);
    await expect(store.remove()).rejects.toBeInstanceOf(LiveLocationUnavailableError);
  });

  it('loadRedisUrl accepts redis:// and rediss:// only, and is null when unset', () => {
    expect(loadRedisUrl({})).toBeNull();
    expect(loadRedisUrl({ REDIS_URL: 'http://x' })).toBeNull();
    expect(loadRedisUrl({ REDIS_URL: 'redis://localhost:6379' })).toBe('redis://localhost:6379');
    expect(loadRedisUrl({ REDIS_URL: ' rediss://h:1 ' })).toBe('rediss://h:1');
  });
});
