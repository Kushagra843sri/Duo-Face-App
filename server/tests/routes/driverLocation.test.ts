import express from 'express';
import request from 'supertest';

import { errorHandler } from '../../src/middleware/errorHandler';
import { createDriverLocationRouter } from '../../src/routes/driver/location';
import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import type { DriverLocationStore } from '../../src/integrations/firebase/FirestoreDriverLocationStore';
import type { DuoFaceDriverStore } from '../../src/integrations/firebase/FirestoreDuoFaceDriverStore';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';
import { DriverLocationService } from '../../src/services/driverLocationService';
import { DriverService } from '../../src/services/driverService';
import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import { getLocationFreshness, LOCATION_STALE_AFTER_MS } from '../../src/services/locationFreshness';
import { DuoFaceRoleResolver } from '../../src/services/roleResolver';

const now = new Date();

function build(options: { role?: 'merchant' | 'driver' | 'unmapped'; driverStatus?: string; locations?: Record<string, Record<string, unknown>> } = {}) {
  const uid = 'uid-1';
  const role = options.role ?? 'driver';
  const identity =
    role === 'merchant'
      ? { firebaseUid: uid, role: 'merchant', status: 'active', merchant: { shopId: 'duo-shop-1' }, createdAt: now, updatedAt: now }
      : { firebaseUid: uid, role: 'driver', status: 'active', driver: { driverId: 'driver-1' }, createdAt: now, updatedAt: now };
  const identityStore: DuoFaceIdentityStore = { get: async () => (role === 'unmapped' ? null : identity), set: async () => {} };

  const driverData = new Map<string, Record<string, unknown>>([
    ['driver-1', { driverId: 'driver-1', firebaseUid: uid, name: 'Ravi', status: options.driverStatus ?? 'active', createdAt: now, updatedAt: now }],
  ]);
  const driverStore: DuoFaceDriverStore = {
    get: async (id) => driverData.get(id) ?? null,
    set: async () => {},
    findByFirebaseUid: async () => null,
    listByStatus: async () => [],
  };

  const locationData = new Map(Object.entries(options.locations ?? {}));
  const writes: Array<{ id: string; data: Record<string, unknown> }> = [];
  const locationStore: DriverLocationStore = {
    get: async (id) => locationData.get(id) ?? null,
    set: async (id, data) => {
      writes.push({ id, data });
      locationData.set(id, data); // replace, like the real store
    },
  };

  const verifier: FirebaseIdentityVerifier = { verifyIdToken: async () => ({ firebaseUid: uid }) };
  const app = express();
  app.use(express.json());
  app.use(
    '/driver/location',
    createDriverLocationRouter(
      verifier,
      new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore)),
      new DriverService(driverStore),
      new DriverLocationService(locationStore)
    )
  );
  app.use(errorHandler);
  return { app, writes, locationData };
}

const auth = { Authorization: 'Bearer token' };
const valid = { latitude: 28.6139, longitude: 77.209, accuracyMeters: 12.5, heading: 180, speedMps: 5.2 };

describe('POST /driver/location', () => {
  it('stores a valid location under the authenticated driver id and returns it', async () => {
    const { app, writes } = build();
    const response = await request(app).post('/driver/location').set(auth).send(valid);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ...valid, freshness: 'fresh' });
    expect(writes).toHaveLength(1);
    expect(writes[0].id).toBe('driver-1');
    expect(writes[0].data.driverId).toBe('driver-1');
  });

  it('never stores firebaseUid, order, customer or address data', async () => {
    const { app, writes } = build();
    await request(app).post('/driver/location').set(auth).send(valid);
    expect(Object.keys(writes[0].data).sort()).toEqual(
      ['accuracyMeters', 'capturedAt', 'driverId', 'heading', 'latitude', 'longitude', 'speedMps', 'updatedAt']
    );
  });

  it('accepts a location with only latitude and longitude', async () => {
    const { app } = build();
    const response = await request(app).post('/driver/location').set(auth).send({ latitude: 1, longitude: 2 });
    expect(response.status).toBe(200);
    expect(response.body.heading).toBeUndefined();
  });

  it.each([
    ['latitude above 90', { ...valid, latitude: 90.1 }],
    ['latitude below -90', { ...valid, latitude: -90.1 }],
    ['longitude above 180', { ...valid, longitude: 180.1 }],
    ['longitude below -180', { ...valid, longitude: -180.1 }],
    ['negative accuracy', { ...valid, accuracyMeters: -1 }],
    ['heading above 360', { ...valid, heading: 361 }],
    ['negative heading', { ...valid, heading: -1 }],
    ['negative speed', { ...valid, speedMps: -0.1 }],
    ['non-numeric latitude', { ...valid, latitude: '28.6' }],
    ['missing latitude', { longitude: 77 }],
    ['missing longitude', { latitude: 28 }],
    ['empty body', {}],
  ])('rejects %s with 400 and writes nothing', async (_name, body) => {
    const { app, writes } = build();
    const response = await request(app).post('/driver/location').set(auth).send(body);
    expect(response.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it('rejects a driverId in the body (cannot submit for another driver)', async () => {
    const { app, writes } = build();
    const response = await request(app).post('/driver/location').set(auth).send({ ...valid, driverId: 'driver-2' });
    expect(response.status).toBe(400);
    expect(writes).toHaveLength(0);
  });

  it('has no /driver/location/:driverId route', async () => {
    const { app } = build();
    expect((await request(app).post('/driver/location/driver-2').set(auth).send(valid)).status).toBe(404);
  });

  it('overwrites the previous location and drops stale optional fields', async () => {
    const { app, locationData } = build();
    await request(app).post('/driver/location').set(auth).send(valid);
    await request(app).post('/driver/location').set(auth).send({ latitude: 10, longitude: 20 });

    expect(locationData.size).toBe(1);
    const stored = locationData.get('driver-1')!;
    expect(stored.latitude).toBe(10);
    expect(stored.heading).toBeUndefined();
  });

  it('returns 401 without a token', async () => {
    expect((await request(build().app).post('/driver/location').send(valid)).status).toBe(401);
  });

  it('returns 403 for a merchant', async () => {
    expect((await request(build({ role: 'merchant' }).app).post('/driver/location').set(auth).send(valid)).status).toBe(403);
  });

  it('returns 403 for an unmapped identity', async () => {
    expect((await request(build({ role: 'unmapped' }).app).post('/driver/location').set(auth).send(valid)).status).toBe(403);
  });

  it('returns 403 for a suspended driver', async () => {
    const { app, writes } = build({ driverStatus: 'suspended' });
    expect((await request(app).post('/driver/location').set(auth).send(valid)).status).toBe(403);
    expect(writes).toHaveLength(0);
  });
});

describe('GET /driver/location', () => {
  it("returns the authenticated driver's latest location with freshness", async () => {
    const { app } = build({
      locations: { 'driver-1': { driverId: 'driver-1', latitude: 5, longitude: 6, capturedAt: now, updatedAt: now } },
    });
    const response = await request(app).get('/driver/location').set(auth);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ latitude: 5, longitude: 6, capturedAt: now.toISOString(), freshness: 'fresh' });
    expect(response.body.driverId).toBeUndefined();
  });

  it('reports stale for an old location', async () => {
    const old = new Date(Date.now() - LOCATION_STALE_AFTER_MS - 1000);
    const { app } = build({ locations: { 'driver-1': { driverId: 'driver-1', latitude: 5, longitude: 6, capturedAt: old, updatedAt: old } } });
    expect((await request(app).get('/driver/location').set(auth)).body.freshness).toBe('stale');
  });

  it('returns 404 when no location has been recorded', async () => {
    expect((await request(build().app).get('/driver/location').set(auth)).status).toBe(404);
  });

  it("does not return another driver's location", async () => {
    const { app } = build({ locations: { 'driver-2': { driverId: 'driver-2', latitude: 5, longitude: 6, capturedAt: now, updatedAt: now } } });
    expect((await request(app).get('/driver/location').set(auth)).status).toBe(404);
  });

  it('returns 401 / 403 for unauthenticated / merchant callers', async () => {
    expect((await request(build().app).get('/driver/location')).status).toBe(401);
    expect((await request(build({ role: 'merchant' }).app).get('/driver/location').set(auth)).status).toBe(403);
  });
});

describe('getLocationFreshness', () => {
  const at = new Date('2026-01-01T12:00:00Z');

  it('is fresh within the threshold, including exactly at it', () => {
    expect(getLocationFreshness(new Date(at.getTime() - 1000), at)).toBe('fresh');
    expect(getLocationFreshness(new Date(at.getTime() - LOCATION_STALE_AFTER_MS), at)).toBe('fresh');
  });

  it('is stale beyond the threshold', () => {
    expect(getLocationFreshness(new Date(at.getTime() - LOCATION_STALE_AFTER_MS - 1), at)).toBe('stale');
  });

  it('honors a custom threshold', () => {
    expect(getLocationFreshness(new Date(at.getTime() - 5000), at, 1000)).toBe('stale');
  });

  it('treats a future capture time as fresh, and null/invalid as stale', () => {
    expect(getLocationFreshness(new Date(at.getTime() + 1000), at)).toBe('fresh');
    expect(getLocationFreshness(null, at)).toBe('stale');
    expect(getLocationFreshness(new Date('nope'), at)).toBe('stale');
  });
});
