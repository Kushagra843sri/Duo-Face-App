import express from 'express';
import request from 'supertest';

import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import type { DuoFaceDriverStore } from '../../src/integrations/firebase/FirestoreDuoFaceDriverStore';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';
import type { DuoFaceShopStore } from '../../src/integrations/firebase/FirestoreDuoFaceShopStore';
import type { CustomerAppShopProvider } from '../../src/integrations/customerApp/CustomerAppShopProvider';
import type { DeliveryGeocoder } from '../../src/integrations/geocoding/DeliveryGeocoder';
import { errorHandler } from '../../src/middleware/errorHandler';
import { createAuthRouter } from '../../src/routes/auth';
import { DriverProvisioningService } from '../../src/services/driverProvisioningService';
import { DriverService } from '../../src/services/driverService';
import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import { DuoFaceRoleResolver } from '../../src/services/roleResolver';
import { DuoFaceShopService } from '../../src/services/duoFaceShopService';
import { MerchantProvisioningService } from '../../src/services/merchantProvisioningService';
import { RegistrationService } from '../../src/services/registrationService';

const verifier: FirebaseIdentityVerifier = { verifyIdToken: async () => ({ firebaseUid: 'new-uid' }) };
const badVerifier: FirebaseIdentityVerifier = {
  verifyIdToken: async () => {
    throw new Error('bad');
  },
};

function kv<T extends Record<string, unknown>>() {
  const data = new Map<string, T>();
  return {
    data,
    get: async (id: string) => data.get(id) ?? null,
    set: async (id: string, v: T) => {
      data.set(id, v);
    },
  };
}

function build(v: FirebaseIdentityVerifier = verifier) {
  const identityKv = kv<Record<string, unknown>>();
  const driverKv = kv<Record<string, unknown>>();
  const shopKv = kv<Record<string, unknown>>();

  const identityStore: DuoFaceIdentityStore = identityKv;
  const driverStore: DuoFaceDriverStore = {
    ...driverKv,
    listByStatus: async (s) => [...driverKv.data.values()].filter((d) => d.status === s),
    findByFirebaseUid: async (uid) => [...driverKv.data.values()].find((d) => d.firebaseUid === uid) ?? null,
  };
  const shopStore: DuoFaceShopStore = {
    ...shopKv,
    findByCustomerAppShopId: async (id) => [...shopKv.data.values()].find((s) => s.customerAppShopId === id) ?? null,
    findByMerchantFirebaseUid: async (uid) => [...shopKv.data.values()].find((s) => s.merchantFirebaseUid === uid) ?? null,
  };

  const identities = new DuoFaceIdentityService(identityStore);
  const drivers = new DriverProvisioningService(identities, new DriverService(driverStore), {
    runAtomic: async ({ identityFirebaseUid, identityData, driverId, driverData }) => {
      await identityStore.set(identityFirebaseUid, identityData);
      await driverStore.set(driverId, driverData);
    },
  });
  const merchants = new MerchantProvisioningService(
    identities,
    new DuoFaceShopService(shopStore),
    {
      runAtomic: async ({ identityFirebaseUid, identityData, shopId, shopData }) => {
        await identityStore.set(identityFirebaseUid, identityData);
        await shopStore.set(shopId, shopData);
      },
    },
    { getShop: async () => null } as CustomerAppShopProvider,
    { geocode: async () => null } as unknown as DeliveryGeocoder
  );

  const app = express();
  app.use(express.json());
  app.use('/auth', createAuthRouter(v, new DuoFaceRoleResolver(identities), new RegistrationService(identities, drivers, merchants)));
  app.use(errorHandler);
  return { app, identityKv, driverKv, shopKv };
}

const auth = { Authorization: 'Bearer t' };

describe('POST /auth/register', () => {
  it('401 without a valid token', async () => {
    const { app } = build(badVerifier);
    const res = await request(app).post('/auth/register').set(auth).send({ intent: 'driver', name: 'A' });
    expect(res.status).toBe(401);
  });

  it('registers a driver; role then resolves from the server record', async () => {
    const { app, identityKv, driverKv } = build();
    const res = await request(app).post('/auth/register').set(auth).send({ intent: 'driver', name: 'Ravi' });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ role: 'driver' });
    expect(identityKv.data.get('new-uid')).toMatchObject({ role: 'driver', status: 'active' });
    expect([...driverKv.data.values()][0]).toMatchObject({ firebaseUid: 'new-uid', name: 'Ravi' });

    const me = await request(app).get('/auth/me').set(auth);
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ role: 'driver' });
  });

  it('registers a merchant with a new server-generated shop', async () => {
    const { app, shopKv } = build();
    const res = await request(app).post('/auth/register').set(auth).send({ intent: 'merchant', shopName: 'Asha Mart' });
    expect(res.status).toBe(201);
    const shop = [...shopKv.data.values()][0];
    expect(shop).toMatchObject({ name: 'Asha Mart', merchantFirebaseUid: 'new-uid', status: 'active' });
    // The customer-visible shop shares the shop's id, so stock and orders line up (decision 031).
    expect(shop.customerAppShopId).toBe(shop.shopId);
    const me = await request(app).get('/auth/me').set(auth);
    expect(me.body).toMatchObject({ role: 'merchant', shopId: shop.shopId });
  });

  it('409 when already registered, and never switches role', async () => {
    const { app, identityKv } = build();
    await request(app).post('/auth/register').set(auth).send({ intent: 'driver', name: 'Ravi' });
    const res = await request(app).post('/auth/register').set(auth).send({ intent: 'merchant', shopName: 'S' });
    expect(res.status).toBe(409);
    expect(identityKv.data.get('new-uid')).toMatchObject({ role: 'driver' });
  });

  it.each([
    [{ intent: 'driver', name: 'A', role: 'merchant' }],
    [{ intent: 'driver', name: 'A', firebaseUid: 'other' }],
    [{ intent: 'driver', name: 'A', driverId: 'x' }],
    [{ intent: 'merchant', shopName: 'S', shopId: 'victim-shop' }],
    [{ intent: 'merchant' }],
    [{ intent: 'admin', name: 'A' }],
    [{ intent: 'driver', name: '  ' }],
  ])('400 for an invalid or over-privileged body %j', async (body) => {
    const { app, identityKv } = build();
    const res = await request(app).post('/auth/register').set(auth).send(body);
    expect(res.status).toBe(400);
    expect(identityKv.data.size).toBe(0);
  });

  it('429 after too many attempts in a minute', async () => {
    const { app } = build();
    let last = 0;
    for (let i = 0; i < 7; i += 1) {
      last = (await request(app).post('/auth/register').set(auth).send({ intent: 'driver', name: '' })).status;
    }
    expect(last).toBe(429);
  });
});
