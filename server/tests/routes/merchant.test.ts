import express from 'express';
import request from 'supertest';

import { createMerchantRouter } from '../../src/routes/merchant';
import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import { DuoFaceShopService } from '../../src/services/duoFaceShopService';
import { DuoFaceRoleResolver } from '../../src/services/roleResolver';
import type { RoleResolver } from '../../src/services/roleResolver';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';
import type { DuoFaceShopStore } from '../../src/integrations/firebase/FirestoreDuoFaceShopStore';

const okVerifier: FirebaseIdentityVerifier = {
  verifyIdToken: async () => ({ firebaseUid: 'uid-1' }),
};

const failingVerifier: FirebaseIdentityVerifier = {
  verifyIdToken: async () => {
    throw new Error('invalid token');
  },
};

const unresolvedResolver: RoleResolver = { resolve: async () => null };

function createFakeIdentityStore(initial: Record<string, Record<string, unknown>> = {}): DuoFaceIdentityStore {
  const data = new Map(Object.entries(initial));
  return {
    async get(firebaseUid) {
      return data.get(firebaseUid) ?? null;
    },
    async set(firebaseUid, value) {
      data.set(firebaseUid, value);
    },
  };
}

function createFakeShopStore(initial: Record<string, Record<string, unknown>> = {}): DuoFaceShopStore {
  const data = new Map(Object.entries(initial));
  return {
    async get(shopId) {
      return data.get(shopId) ?? null;
    },
    async set(shopId, value) {
      data.set(shopId, value);
    },
    async findByCustomerAppShopId(customerAppShopId) {
      for (const v of data.values()) if (v.customerAppShopId === customerAppShopId) return v;
      return null;
    },
    async findByMerchantFirebaseUid(merchantFirebaseUid) {
      for (const value of data.values()) {
        if (value.merchantFirebaseUid === merchantFirebaseUid) return value;
      }
      return null;
    },
  };
}

function buildApp(
  verifier: FirebaseIdentityVerifier,
  roleResolver: RoleResolver,
  shopService: DuoFaceShopService = new DuoFaceShopService(createFakeShopStore())
) {
  const app = express();
  app.use('/merchant', createMerchantRouter(verifier, roleResolver, shopService));
  return app;
}

const now = new Date();

describe('GET /merchant/me', () => {
  it('returns 401 without an Authorization header', async () => {
    const response = await request(buildApp(okVerifier, unresolvedResolver)).get('/merchant/me');
    expect(response.status).toBe(401);
  });

  it('returns 401 for an invalid Firebase token', async () => {
    const response = await request(buildApp(failingVerifier, unresolvedResolver))
      .get('/merchant/me')
      .set('Authorization', 'Bearer bad-token');
    expect(response.status).toBe(401);
  });

  it('returns 403 for a valid identity with no Duo-Face mapping', async () => {
    const response = await request(buildApp(okVerifier, unresolvedResolver))
      .get('/merchant/me')
      .set('Authorization', 'Bearer good-token');
    expect(response.status).toBe(403);
  });

  it('returns 403 for a driver identity', async () => {
    const identityStore = createFakeIdentityStore({
      'uid-1': {
        firebaseUid: 'uid-1',
        role: 'driver',
        status: 'active',
        driver: { driverId: 'driver-1' },
        createdAt: now,
        updatedAt: now,
      },
    });
    const roleResolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore));

    const response = await request(buildApp(okVerifier, roleResolver))
      .get('/merchant/me')
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(403);
  });

  it('returns 403 for a suspended merchant identity', async () => {
    const identityStore = createFakeIdentityStore({
      'uid-1': {
        firebaseUid: 'uid-1',
        role: 'merchant',
        status: 'suspended',
        merchant: { shopId: 'shop-1' },
        createdAt: now,
        updatedAt: now,
      },
    });
    const roleResolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore));

    const response = await request(buildApp(okVerifier, roleResolver))
      .get('/merchant/me')
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(403);
  });

  it('returns 403 for an active merchant whose shop is missing', async () => {
    const identityStore = createFakeIdentityStore({
      'uid-1': {
        firebaseUid: 'uid-1',
        role: 'merchant',
        status: 'active',
        merchant: { shopId: 'shop-1' },
        createdAt: now,
        updatedAt: now,
      },
    });
    const roleResolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore));
    const shopService = new DuoFaceShopService(createFakeShopStore()); // no shop-1

    const response = await request(buildApp(okVerifier, roleResolver, shopService))
      .get('/merchant/me')
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(403);
  });

  it('returns 403 for an active merchant whose shop belongs to a different uid', async () => {
    const identityStore = createFakeIdentityStore({
      'uid-1': {
        firebaseUid: 'uid-1',
        role: 'merchant',
        status: 'active',
        merchant: { shopId: 'shop-1' },
        createdAt: now,
        updatedAt: now,
      },
    });
    const roleResolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore));
    const shopService = new DuoFaceShopService(
      createFakeShopStore({
        'shop-1': {
          shopId: 'shop-1',
          name: 'X',
          status: 'active',
          merchantFirebaseUid: 'someone-else',
          createdAt: now,
          updatedAt: now,
        },
      })
    );

    const response = await request(buildApp(okVerifier, roleResolver, shopService))
      .get('/merchant/me')
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(403);
  });

  it('returns 200 with the minimal principal + shop info for a valid active merchant', async () => {
    const identityStore = createFakeIdentityStore({
      'uid-1': {
        firebaseUid: 'uid-1',
        role: 'merchant',
        status: 'active',
        merchant: { shopId: 'shop-1' },
        createdAt: now,
        updatedAt: now,
      },
    });
    const roleResolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore));
    const shopService = new DuoFaceShopService(
      createFakeShopStore({
        'shop-1': {
          shopId: 'shop-1',
          name: 'Sharma Kirana',
          status: 'active',
          merchantFirebaseUid: 'uid-1',
          createdAt: now,
          updatedAt: now,
        },
      })
    );

    const response = await request(buildApp(okVerifier, roleResolver, shopService))
      .get('/merchant/me')
      .set('Authorization', 'Bearer good-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      firebaseUid: 'uid-1',
      role: 'merchant',
      shopId: 'shop-1',
      shopName: 'Sharma Kirana',
    });
  });
});
