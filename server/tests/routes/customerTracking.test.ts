import express from 'express';
import request from 'supertest';

import { errorHandler } from '../../src/middleware/errorHandler';
import { createCustomerTrackingRouter, CUSTOMER_TRACKING_RATE_LIMIT } from '../../src/routes/customer/tracking';
import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import { LiveLocationUnavailableError } from '../../src/integrations/redis/LiveDriverLocationStore';
import type { LiveDriverLocationStore } from '../../src/integrations/redis/LiveDriverLocationStore';
import { CustomerTrackingService } from '../../src/services/customerTrackingService';
import { toCustomerStatus } from '../../src/services/customerTrackingStatus';
import { LIVE_LOCATION_STALE_AFTER_MS } from '../../src/services/locationFreshness';
import { assignment, buildCustomerFixture, clock, order, T0 } from '../helpers/trackingFixtures';
import type { CustomerFixtureOptions } from '../helpers/trackingFixtures';

const tokens: Record<string, string> = {
  'token-A': 'customer-A',
  'token-B': 'customer-B',
  'token-merchant': 'merchant-uid',
  'token-driver': 'driver-uid',
};
const verifier: FirebaseIdentityVerifier = {
  verifyIdToken: async (token) => {
    const firebaseUid = tokens[token];
    if (!firebaseUid) throw new Error('bad token');
    return { firebaseUid };
  },
};
const asA = { Authorization: 'Bearer token-A' };

function build(options: CustomerFixtureOptions = {}, live?: LiveDriverLocationStore) {
  const fixture = buildCustomerFixture(options);
  const service = live
    ? new CustomerTrackingService(fixture.orderProvider, fixture.assignments, live, fixture.geocoder, () => clock.now)
    : fixture.service;
  const app = express();
  app.use('/customer', createCustomerTrackingRouter(verifier, service));
  app.use(errorHandler);
  return { app, ...fixture };
}

async function publishLive(fixture: ReturnType<typeof build>, overrides: Record<string, unknown> = {}) {
  await fixture.live.update({
    driverId: 'driver-1',
    assignmentId: 'a-1',
    latitude: 28.6139,
    longitude: 77.209,
    accuracyMeters: 10,
    heading: 90,
    speedMps: 4,
    capturedAt: new Date(clock.now),
    ...overrides,
  });
}

const URL = '/customer/orders/order-1/tracking';

beforeEach(() => {
  clock.now = T0;
});

describe('GET /customer/orders/:orderId/tracking — authentication & ownership', () => {
  it('401 without a token, and with an invalid token', async () => {
    const { app } = build();
    expect((await request(app).get(URL)).status).toBe(401);
    expect((await request(app).get(URL).set({ Authorization: 'Bearer nope' })).status).toBe(401);
  });

  it('200 for the customer who owns the order', async () => {
    const f = build();
    await publishLive(f);
    expect((await request(f.app).get(URL).set(asA)).status).toBe(200);
  });

  it("404 for another customer's order (indistinguishable from a missing one)", async () => {
    const f = build();
    await publishLive(f);
    const other = await request(f.app).get(URL).set({ Authorization: 'Bearer token-B' });
    const missing = await request(f.app).get('/customer/orders/nope/tracking').set(asA);
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(other.body).toEqual(missing.body);
  });

  it('a merchant or driver identity gets no special access: 404 for orders they do not own', async () => {
    const f = build();
    await publishLive(f);
    expect((await request(f.app).get(URL).set({ Authorization: 'Bearer token-merchant' })).status).toBe(404);
    expect((await request(f.app).get(URL).set({ Authorization: 'Bearer token-driver' })).status).toBe(404);
  });

  it('no customerId / driverId can be supplied: query params are ignored', async () => {
    const f = build();
    const response = await request(f.app).get(`${URL}?customerId=customer-A&driverId=driver-1`).set({ Authorization: 'Bearer token-B' });
    expect(response.status).toBe(404);
  });

  it('a malformed order (no customerId) is never served', async () => {
    const f = build({ orders: { 'order-1': { ...order(), customerId: undefined } } });
    expect((await request(f.app).get(URL).set(asA)).status).toBe(404);
  });

  it('an order whose stored orderId does not match is never served', async () => {
    const f = build({ orders: { 'order-1': order({ orderId: 'order-9' }) } });
    expect((await request(f.app).get(URL).set(asA)).status).toBe(404);
  });
});

describe('tracking availability by assignment status', () => {
  it.each(['accepted', 'picked_up'])('%s + live location -> available with location and destination', async (status) => {
    const f = build({ assignments: { 'a-1': assignment('a-1', status) } });
    await publishLive(f);
    const { tracking } = (await request(f.app).get(URL).set(asA)).body;
    expect(tracking).toMatchObject({
      available: true,
      status,
      location: { latitude: 28.6139, longitude: 77.209, fresh: true },
      destination: { latitude: 28.7, longitude: 77.3 },
    });
  });

  it.each([
    ['assigned', 'assigned'],
    ['rejected', 'pending'],
    ['delivered', 'delivered'],
    ['cancelled', 'cancelled'],
  ])('%s -> unavailable, status %s, and NO coordinates even if Redis has a position', async (status, expected) => {
    const f = build({ assignments: { 'a-1': assignment('a-1', status) } });
    await publishLive(f);
    const { tracking } = (await request(f.app).get(URL).set(asA)).body;
    expect(tracking.available).toBe(false);
    expect(tracking.status).toBe(expected);
    expect(tracking.location).toBeUndefined();
    expect(tracking.destination).toBeUndefined();
  });

  it('no assignment at all -> pending / unavailable', async () => {
    const f = build({ assignments: {} });
    const { tracking } = (await request(f.app).get(URL).set(asA)).body;
    expect(tracking).toMatchObject({ available: false, status: 'pending' });
  });

  it('accepted but no Redis location -> unavailable (never manufactured), destination still shown', async () => {
    const f = build();
    const { tracking } = (await request(f.app).get(URL).set(asA)).body;
    expect(tracking.available).toBe(false);
    expect(tracking.location).toBeUndefined();
    expect(tracking.destination).toEqual({ latitude: 28.7, longitude: 77.3 });
  });

  it('prefers the active assignment over an older rejected one', async () => {
    const f = build({
      assignments: {
        old: assignment('old', 'rejected', { driverId: 'driver-0', assignedAt: new Date(T0 - 1000) }),
        'a-1': assignment('a-1', 'accepted'),
      },
    });
    await publishLive(f);
    expect((await request(f.app).get(URL).set(asA)).body.tracking).toMatchObject({ available: true, status: 'accepted' });
  });

  it("ignores an assignment for a different shop with the same orderId", async () => {
    const f = build({ assignments: { 'a-1': assignment('a-1', 'accepted', { customerAppShopId: 'other-shop' }) } });
    await publishLive(f);
    expect((await request(f.app).get(URL).set(asA)).body.tracking).toMatchObject({ available: false, status: 'pending' });
  });

  it('toCustomerStatus maps unknown/rejected/none to pending', () => {
    expect(toCustomerStatus(undefined)).toBe('pending');
    expect(toCustomerStatus('rejected')).toBe('pending');
  });
});

describe('live location safety', () => {
  it('never exposes a position published for a different assignment', async () => {
    const f = build();
    await publishLive(f, { assignmentId: 'previous-assignment' });
    const { tracking } = (await request(f.app).get(URL).set(asA)).body;
    expect(tracking.available).toBe(false);
    expect(tracking.location).toBeUndefined();
  });

  it('marks a position older than the live threshold as stale (fresh:false) but still returns it', async () => {
    const f = build();
    await publishLive(f);
    clock.now = T0 + LIVE_LOCATION_STALE_AFTER_MS + 1000;
    const { tracking } = (await request(f.app).get(URL).set(asA)).body;
    expect(tracking.available).toBe(true);
    expect(tracking.location.fresh).toBe(false);
  });

  it('a position past the Redis TTL is gone', async () => {
    const f = build();
    await publishLive(f);
    clock.now = T0 + 300_001;
    expect((await request(f.app).get(URL).set(asA)).body.tracking.available).toBe(false);
  });

  it('degrades to unavailable (not an error) when Redis is down', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const down: LiveDriverLocationStore = {
      update: async () => { throw new LiveLocationUnavailableError(); },
      get: async () => { throw new LiveLocationUnavailableError(); },
      has: async () => { throw new LiveLocationUnavailableError(); },
      remove: async () => { throw new LiveLocationUnavailableError(); },
    };
    const f = build({}, down);
    const response = await request(f.app).get(URL).set(asA);
    warn.mockRestore();
    expect(response.status).toBe(200);
    expect(response.body.tracking).toMatchObject({ available: false, status: 'accepted' });
  });

  it('a geocoder failure only removes the destination', async () => {
    const f = build({ geocoder: { geocode: async () => { throw new Error('down'); } } });
    await publishLive(f);
    const { tracking } = (await request(f.app).get(URL).set(asA)).body;
    expect(tracking.available).toBe(true);
    expect(tracking.destination).toBeUndefined();
  });
});

describe('privacy of the DTO and the Customer App boundary', () => {
  it('exposes only the documented fields — no driver/assignment ids, contact, accuracy, address, payment', async () => {
    const f = build();
    await publishLive(f);
    const body = (await request(f.app).get(URL).set(asA)).body;

    expect(Object.keys(body)).toEqual(['tracking']);
    expect(Object.keys(body.tracking).sort()).toEqual(['available', 'destination', 'location', 'status', 'updatedAt']);
    expect(Object.keys(body.tracking.location).sort()).toEqual(['capturedAt', 'fresh', 'latitude', 'longitude']);

    const text = JSON.stringify(body);
    for (const banned of ['driver-1', 'a-1', 'assignmentId', 'driverId', 'firebaseUid', 'customer-A', 'pay_SECRET', '+911234567890', 'MG Road', 'accuracy', 'heading', 'speed', 'duo_face:']) {
      expect(text).not.toContain(banned);
    }
  });

  it('only reads the Customer App order — never writes it', async () => {
    const f = build();
    await publishLive(f);
    await request(f.app).get(URL).set(asA);
    expect(f.orderProvider.reads).toBeGreaterThan(0);
    expect(f.orderProvider.writes).toBe(0);
  });
});

describe('rate limiting', () => {
  it('limits lookups per Firebase UID (order-probing protection)', async () => {
    expect(CUSTOMER_TRACKING_RATE_LIMIT).toEqual({ windowMs: 60_000, max: 30 });
    const f = build();
    let last = 0;
    for (let i = 0; i < CUSTOMER_TRACKING_RATE_LIMIT.max + 1; i++) {
      last = (await request(f.app).get(URL).set(asA)).status;
    }
    expect(last).toBe(429);
    // another customer is unaffected
    expect((await request(f.app).get(URL).set({ Authorization: 'Bearer token-B' })).status).toBe(404);
  });
});
