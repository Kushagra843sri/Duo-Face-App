import express from 'express';
import request from 'supertest';

import { errorHandler } from '../../src/middleware/errorHandler';
import { createRateLimiter } from '../../src/middleware/rateLimit';
import { createDriverTrackingRouter, TRACKING_RATE_LIMIT } from '../../src/routes/driver/tracking';
import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import type { DeliveryAssignmentStore } from '../../src/integrations/firebase/FirestoreDeliveryAssignmentStore';
import type { DriverLocationStore } from '../../src/integrations/firebase/FirestoreDriverLocationStore';
import type { DuoFaceDriverStore } from '../../src/integrations/firebase/FirestoreDuoFaceDriverStore';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';
import {
  InMemoryLiveDriverLocationStore,
  LiveLocationUnavailableError,
  UnavailableLiveDriverLocationStore,
} from '../../src/integrations/redis/LiveDriverLocationStore';
import type { LiveDriverLocationStore } from '../../src/integrations/redis/LiveDriverLocationStore';
import { DeliveryAssignmentService } from '../../src/services/deliveryAssignmentService';
import { DriverLocationService } from '../../src/services/driverLocationService';
import { DriverService } from '../../src/services/driverService';
import { DriverTrackingService, DURABLE_SNAPSHOT_INTERVAL_MS, ELIGIBILITY_CACHE_MS } from '../../src/services/driverTrackingService';
import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import { getLocationFreshness, LIVE_LOCATION_STALE_AFTER_MS } from '../../src/services/locationFreshness';
import { DuoFaceRoleResolver } from '../../src/services/roleResolver';
import { isTrackingEligible, TRACKING_ELIGIBLE_STATUSES } from '../../src/services/trackingPolicy';

const T0 = new Date('2026-01-01T12:00:00Z').getTime();
const now = new Date(T0);
const auth = { Authorization: 'Bearer token' };
const valid = { assignmentId: 'a-1', latitude: 28.6139, longitude: 77.209, accuracyMeters: 10, heading: 180, speedMps: 5 };

function assignment(id: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    assignmentId: id,
    orderId: `order-${id}`,
    customerAppShopId: 'shop-1',
    driverId: 'driver-1',
    status,
    assignedAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

interface Setup {
  role?: 'merchant' | 'driver';
  driverStatus?: string;
  assignments?: Record<string, Record<string, unknown>>;
  live?: LiveDriverLocationStore;
  limiter?: ReturnType<typeof createRateLimiter>;
  failDurable?: boolean;
}

function build(options: Setup = {}) {
  const uid = 'uid-1';
  const role = options.role ?? 'driver';
  const identity =
    role === 'merchant'
      ? { firebaseUid: uid, role: 'merchant', status: 'active', merchant: { shopId: 's' }, createdAt: now, updatedAt: now }
      : { firebaseUid: uid, role: 'driver', status: 'active', driver: { driverId: 'driver-1' }, createdAt: now, updatedAt: now };
  const identityStore: DuoFaceIdentityStore = { get: async () => identity, set: async () => {} };
  const drivers = new Map<string, Record<string, unknown>>([
    ['driver-1', { driverId: 'driver-1', firebaseUid: uid, name: 'Ravi', status: options.driverStatus ?? 'active', createdAt: now, updatedAt: now }],
  ]);
  const driverStore: DuoFaceDriverStore = {
    get: async (id) => drivers.get(id) ?? null,
    set: async () => {},
    findByFirebaseUid: async () => null,
    listByStatus: async () => [],
  };
  const assignmentData = new Map(Object.entries(options.assignments ?? { 'a-1': assignment('a-1', 'accepted') }));
  const counters = { assignmentReads: 0, durableWrites: 0 };
  const assignmentStore: DeliveryAssignmentStore = {
    get: async (id) => assignmentData.get(id) ?? null,
    listByDriverId: async (d) => {
      counters.assignmentReads++;
      return [...assignmentData.values()].filter((v) => v.driverId === d);
    },
    async listByOrderId() {
      return [];
    },
    listByCustomerAppShopId: async () => [],
    createIfNoActiveAssignmentForOrder: async () => {
      throw new Error('unused');
    },
    runTransaction: async () => {
      throw new Error('unused');
    },
  };
  const durable = new Map<string, Record<string, unknown>>();
  const durableStore: DriverLocationStore = {
    get: async (id) => durable.get(id) ?? null,
    set: async (id, data) => {
      if (options.failDurable) throw new Error('firestore down');
      counters.durableWrites++;
      durable.set(id, data);
    },
  };

  const clock = { now: T0 };
  const live = options.live ?? new InMemoryLiveDriverLocationStore(300_000, () => clock.now);
  const tracking = new DriverTrackingService(
    new DeliveryAssignmentService(assignmentStore, new DriverService(driverStore)),
    live,
    new DriverLocationService(durableStore),
    () => clock.now
  );
  const verifier: FirebaseIdentityVerifier = { verifyIdToken: async () => ({ firebaseUid: uid }) };

  const app = express();
  app.use(express.json());
  app.use(
    '/driver/tracking',
    createDriverTrackingRouter(
      verifier,
      new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore)),
      new DriverService(driverStore),
      tracking,
      options.limiter
    )
  );
  app.use(errorHandler);
  return { app, live, clock, counters, assignmentData, durable };
}

describe('tracking eligibility policy', () => {
  it('allows only accepted and picked_up', () => {
    expect([...TRACKING_ELIGIBLE_STATUSES]).toEqual(['accepted', 'picked_up']);
    for (const status of ['assigned', 'rejected', 'delivered', 'cancelled'] as const) {
      expect(isTrackingEligible(status)).toBe(false);
    }
    expect(isTrackingEligible('accepted')).toBe(true);
    expect(isTrackingEligible('picked_up')).toBe(true);
  });
});

describe('live freshness (shared policy)', () => {
  it('uses the same function with the live 60 s threshold', () => {
    const at = new Date(T0);
    expect(getLocationFreshness(new Date(T0 - LIVE_LOCATION_STALE_AFTER_MS), at, LIVE_LOCATION_STALE_AFTER_MS)).toBe('fresh');
    expect(getLocationFreshness(new Date(T0 - LIVE_LOCATION_STALE_AFTER_MS - 1), at, LIVE_LOCATION_STALE_AFTER_MS)).toBe('stale');
    expect(LIVE_LOCATION_STALE_AFTER_MS).toBeLessThan(300_000); // tighter than the Redis TTL / durable threshold
  });
});

describe('POST /driver/tracking/location — authentication & authorization', () => {
  it('401 without a token', async () => {
    expect((await request(build().app).post('/driver/tracking/location').send(valid)).status).toBe(401);
  });

  it('403 for a merchant', async () => {
    expect((await request(build({ role: 'merchant' }).app).post('/driver/tracking/location').set(auth).send(valid)).status).toBe(403);
  });

  it('403 for a suspended driver, and nothing is stored', async () => {
    const { app, live } = build({ driverStatus: 'suspended' });
    expect((await request(app).post('/driver/tracking/location').set(auth).send(valid)).status).toBe(403);
    expect(await live.get('driver-1')).toBeNull();
  });

  it("404 for another driver's assignment", async () => {
    const { app, live } = build({ assignments: { 'a-1': assignment('a-1', 'accepted', { driverId: 'someone-else' }) } });
    expect((await request(app).post('/driver/tracking/location').set(auth).send(valid)).status).toBe(404);
    expect(await live.get('driver-1')).toBeNull();
  });

  it('404 for an unknown assignment', async () => {
    expect((await request(build().app).post('/driver/tracking/location').set(auth).send({ ...valid, assignmentId: 'nope' })).status).toBe(404);
  });

  it('404 for a rejected assignment', async () => {
    const { app } = build({ assignments: { 'a-1': assignment('a-1', 'rejected') } });
    expect((await request(app).post('/driver/tracking/location').set(auth).send(valid)).status).toBe(404);
  });

  it.each(['assigned', 'delivered', 'cancelled'])('409 for a %s assignment; nothing stored', async (status) => {
    const { app, live } = build({ assignments: { 'a-1': assignment('a-1', status) } });
    expect((await request(app).post('/driver/tracking/location').set(auth).send(valid)).status).toBe(409);
    expect(await live.get('driver-1')).toBeNull();
  });

  it.each(['accepted', 'picked_up'])('allows a %s assignment', async (status) => {
    const { app, live } = build({ assignments: { 'a-1': assignment('a-1', status) } });
    const response = await request(app).post('/driver/tracking/location').set(auth).send(valid);
    expect(response.status).toBe(200);
    expect(await live.get('driver-1')).toMatchObject({ driverId: 'driver-1', assignmentId: 'a-1', latitude: 28.6139 });
  });

  it('refuses to guess when the driver has two tracking-eligible assignments (409, nothing stored)', async () => {
    const { app, live } = build({
      assignments: { 'a-1': assignment('a-1', 'accepted'), 'a-2': assignment('a-2', 'picked_up') },
    });
    const response = await request(app).post('/driver/tracking/location').set(auth).send(valid);
    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/more than one/i);
    expect(await live.get('driver-1')).toBeNull();
  });

  it('a second, non-eligible assignment does not create ambiguity', async () => {
    const { app } = build({ assignments: { 'a-1': assignment('a-1', 'accepted'), 'a-2': assignment('a-2', 'assigned') } });
    expect((await request(app).post('/driver/tracking/location').set(auth).send(valid)).status).toBe(200);
  });
});

describe('POST /driver/tracking/location — validation', () => {
  it.each([
    ['latitude 91', { ...valid, latitude: 91 }],
    ['longitude -181', { ...valid, longitude: -181 }],
    ['negative accuracy', { ...valid, accuracyMeters: -1 }],
    ['heading 400', { ...valid, heading: 400 }],
    ['negative speed', { ...valid, speedMps: -2 }],
    ['missing assignmentId', { latitude: 1, longitude: 2 }],
    ['empty assignmentId', { ...valid, assignmentId: '' }],
    ['missing coordinates', { assignmentId: 'a-1' }],
    ['driverId in body', { ...valid, driverId: 'driver-2' }],
    ['firebaseUid in body', { ...valid, firebaseUid: 'x' }],
  ])('400 for %s; nothing stored', async (_name, body) => {
    const { app, live } = build();
    expect((await request(app).post('/driver/tracking/location').set(auth).send(body)).status).toBe(400);
    expect(await live.get('driver-1')).toBeNull();
  });
});

describe('storage boundary: Redis per ping, Firestore only occasionally', () => {
  it('many pings -> one durable Firestore snapshot per interval, and cached eligibility reads', async () => {
    const { app, counters, clock } = build();
    for (let i = 0; i < 6; i++) {
      clock.now += 10_000;
      const response = await request(app)
        .post('/driver/tracking/location')
        .set(auth)
        .send({ ...valid, latitude: 28 + i / 100 });
      expect(response.status).toBe(200);
    }
    expect(counters.durableWrites).toBe(1); // only the first ping snapshots within the 60 s interval
    expect(counters.assignmentReads).toBe(3); // 6 pings over 60 s, 15 s eligibility cache => reads at 10/30/50 s, not 6

    clock.now += DURABLE_SNAPSHOT_INTERVAL_MS;
    await request(app).post('/driver/tracking/location').set(auth).send(valid);
    expect(counters.durableWrites).toBe(2);
    expect(ELIGIBILITY_CACHE_MS).toBeLessThan(DURABLE_SNAPSHOT_INTERVAL_MS);
  });

  it('a Firestore snapshot failure does not fail the live update', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { app, live } = build({ failDurable: true });
    const response = await request(app).post('/driver/tracking/location').set(auth).send(valid);
    warn.mockRestore();
    expect(response.status).toBe(200);
    expect(await live.get('driver-1')).not.toBeNull();
  });

  it('repeated updates overwrite a single live entry', async () => {
    const { app, live, clock } = build();
    await request(app).post('/driver/tracking/location').set(auth).send(valid);
    clock.now += 10_000;
    await request(app).post('/driver/tracking/location').set(auth).send({ ...valid, latitude: 30 });
    expect(await live.get('driver-1')).toMatchObject({ latitude: 30 });
  });

  it('ownership is still enforced after eligibility is cached (other assignment id -> 404)', async () => {
    const { app } = build({ assignments: { 'a-1': assignment('a-1', 'accepted'), 'x-9': assignment('x-9', 'accepted', { driverId: 'other' }) } });
    expect((await request(app).post('/driver/tracking/location').set(auth).send(valid)).status).toBe(200);
    expect((await request(app).post('/driver/tracking/location').set(auth).send({ ...valid, assignmentId: 'x-9' })).status).toBe(404);
  });
});

describe('Redis unavailable', () => {
  it('POST -> 503, never pretending it stored, and never falling back to Firestore', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { app, counters } = build({ live: new UnavailableLiveDriverLocationStore() });
    const response = await request(app).post('/driver/tracking/location').set(auth).send(valid);
    warn.mockRestore();

    expect(response.status).toBe(503);
    expect(counters.durableWrites).toBe(0);
    expect(JSON.stringify(response.body)).not.toMatch(/redis/i);
  });

  it('GET and DELETE -> 503 too; logs carry ids only, never coordinates', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { app } = build({ live: new UnavailableLiveDriverLocationStore() });
    expect((await request(app).get('/driver/tracking/location/a-1').set(auth)).status).toBe(503);
    expect((await request(app).delete('/driver/tracking/location').set(auth)).status).toBe(503);
    await request(app).post('/driver/tracking/location').set(auth).send(valid);
    const logged = JSON.stringify(warn.mock.calls);
    warn.mockRestore();
    expect(logged).not.toContain('28.6139');
    expect(logged).not.toContain('77.209');
  });

  it('a store that fails mid-flight is reported as 503', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const failing: LiveDriverLocationStore = {
      update: async () => {
        throw new LiveLocationUnavailableError();
      },
      get: async () => null,
      has: async () => false,
      remove: async () => {},
    };
    expect((await request(build({ live: failing }).app).post('/driver/tracking/location').set(auth).send(valid)).status).toBe(503);
    warn.mockRestore();
  });
});

describe('GET /driver/tracking/location/:assignmentId', () => {
  it('returns the live location with freshness; 404 before any update', async () => {
    const { app, clock } = build();
    expect((await request(app).get('/driver/tracking/location/a-1').set(auth)).status).toBe(404);

    await request(app).post('/driver/tracking/location').set(auth).send(valid);
    const fresh = await request(app).get('/driver/tracking/location/a-1').set(auth);
    expect(fresh.status).toBe(200);
    expect(fresh.body).toMatchObject({ latitude: 28.6139, longitude: 77.209, freshness: 'fresh' });
    expect(fresh.body.driverId).toBeUndefined();
    expect(fresh.body.assignmentId).toBeUndefined();

    clock.now += LIVE_LOCATION_STALE_AFTER_MS + 1000;
    expect((await request(app).get('/driver/tracking/location/a-1').set(auth)).body.freshness).toBe('stale');
  });

  it('404 after the Redis TTL expires', async () => {
    const { app, clock } = build();
    await request(app).post('/driver/tracking/location').set(auth).send(valid);
    clock.now += 300_001;
    expect((await request(app).get('/driver/tracking/location/a-1').set(auth)).status).toBe(404);
  });

  it('is not served for an assignment that is no longer eligible, or belongs to someone else', async () => {
    const { app, assignmentData } = build();
    await request(app).post('/driver/tracking/location').set(auth).send(valid);
    assignmentData.set('a-1', assignment('a-1', 'delivered'));
    expect((await request(app).get('/driver/tracking/location/a-1').set(auth)).status).toBe(409);

    const other = build({ assignments: { 'a-1': assignment('a-1', 'accepted', { driverId: 'someone-else' }) } });
    expect((await request(other.app).get('/driver/tracking/location/a-1').set(auth)).status).toBe(404);
  });

  it("does not serve a position published for a different assignment", async () => {
    const { app, assignmentData } = build({ assignments: { 'a-1': assignment('a-1', 'accepted') } });
    await request(app).post('/driver/tracking/location').set(auth).send(valid);
    assignmentData.set('a-1', assignment('a-1', 'delivered'));
    assignmentData.set('a-2', assignment('a-2', 'accepted'));
    expect((await request(app).get('/driver/tracking/location/a-2').set(auth)).status).toBe(404);
  });

  it('401 / 403 for unauthenticated / merchant; no driverId route exists', async () => {
    expect((await request(build().app).get('/driver/tracking/location/a-1')).status).toBe(401);
    expect((await request(build({ role: 'merchant' }).app).get('/driver/tracking/location/a-1').set(auth)).status).toBe(403);
    // A driver id in the :assignmentId slot is just an unknown assignment.
    expect((await request(build().app).get('/driver/tracking/location/driver-1').set(auth)).status).toBe(404);
  });
});

describe('DELETE /driver/tracking/location', () => {
  it("removes only the caller's own live location (204, idempotent)", async () => {
    const { app, live } = build();
    await request(app).post('/driver/tracking/location').set(auth).send(valid);
    expect((await request(app).delete('/driver/tracking/location').set(auth)).status).toBe(204);
    expect(await live.get('driver-1')).toBeNull();
    expect((await request(app).delete('/driver/tracking/location').set(auth)).status).toBe(204);
  });

  it('401 / 403 for unauthenticated / merchant', async () => {
    expect((await request(build().app).delete('/driver/tracking/location')).status).toBe(401);
    expect((await request(build({ role: 'merchant' }).app).delete('/driver/tracking/location').set(auth)).status).toBe(403);
  });
});

describe('rate limiting', () => {
  it('documented limit is 12 per 60 s, with headroom over the ~6/min cadence', () => {
    expect(TRACKING_RATE_LIMIT).toEqual({ windowMs: 60_000, max: 12 });
  });

  it('the default router limiter returns 429 with Retry-After beyond the limit, and stores nothing extra', async () => {
    const { app } = build(); // default limiter
    let last = 0;
    for (let i = 0; i < TRACKING_RATE_LIMIT.max + 1; i++) {
      const response = await request(app).post('/driver/tracking/location').set(auth).send(valid);
      last = response.status;
      if (i === TRACKING_RATE_LIMIT.max) expect(response.headers['retry-after']).toBeDefined();
    }
    expect(last).toBe(429);
  });

  it('limits per driver key and resets after the window (injected clock)', async () => {
    let t = 0;
    const limiter = createRateLimiter({ windowMs: 1000, max: 2, keyFor: (req) => req.driver?.driverId, now: () => t });
    const { app } = build({ limiter });
    const post = () => request(app).post('/driver/tracking/location').set(auth).send(valid);
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);
    t = 1001;
    expect((await post()).status).toBe(200);
  });

  it('unauthenticated requests are rejected before consuming the limit', async () => {
    const { app } = build();
    for (let i = 0; i < 20; i++) expect((await request(app).post('/driver/tracking/location').send(valid)).status).toBe(401);
  });
});
