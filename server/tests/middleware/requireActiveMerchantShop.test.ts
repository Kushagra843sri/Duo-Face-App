import express from 'express';
import request from 'supertest';

import { requireActiveMerchantShop } from '../../src/middleware/requireActiveMerchantShop';
import { DuoFaceShopService } from '../../src/services/duoFaceShopService';
import type { DuoFaceShopStore } from '../../src/integrations/firebase/FirestoreDuoFaceShopStore';
import type { AuthenticatedRequest } from '../../src/types/auth';

function createFakeStore(initial: Record<string, Record<string, unknown>> = {}): DuoFaceShopStore {
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

function buildApp(shopService: DuoFaceShopService, principal: AuthenticatedRequest['principal']) {
  const app = express();
  app.get(
    '/protected',
    (req: AuthenticatedRequest, _res, next) => {
      req.principal = principal;
      next();
    },
    requireActiveMerchantShop(shopService),
    (req: AuthenticatedRequest, res) => res.json({ shop: req.shop })
  );
  return app;
}

const activeShopStore = createFakeStore({
  'shop-1': {
    shopId: 'shop-1',
    name: 'Sharma Kirana',
    status: 'active',
    merchantFirebaseUid: 'uid-1',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
});

describe('requireActiveMerchantShop', () => {
  it('calls next() and attaches req.shop for an active, matching shop', async () => {
    const app = buildApp(new DuoFaceShopService(activeShopStore), {
      firebaseUid: 'uid-1',
      role: 'merchant',
      shopId: 'shop-1',
    });

    const response = await request(app).get('/protected');
    expect(response.status).toBe(200);
    expect(response.body.shop).toMatchObject({ shopId: 'shop-1', status: 'active' });
  });

  it('rejects when the principal has no shopId', async () => {
    const app = buildApp(new DuoFaceShopService(createFakeStore()), {
      firebaseUid: 'uid-1',
      role: 'merchant',
    });

    const response = await request(app).get('/protected');
    expect(response.status).toBe(403);
  });

  it('rejects when the shop does not exist', async () => {
    const app = buildApp(new DuoFaceShopService(createFakeStore()), {
      firebaseUid: 'uid-1',
      role: 'merchant',
      shopId: 'missing-shop',
    });

    const response = await request(app).get('/protected');
    expect(response.status).toBe(403);
  });

  it('rejects when the shop belongs to a different firebaseUid', async () => {
    const app = buildApp(new DuoFaceShopService(activeShopStore), {
      firebaseUid: 'attacker-uid',
      role: 'merchant',
      shopId: 'shop-1',
    });

    const response = await request(app).get('/protected');
    expect(response.status).toBe(403);
  });

  it('rejects when the shop is suspended', async () => {
    const suspendedStore = createFakeStore({
      'shop-1': {
        shopId: 'shop-1',
        name: 'X',
        status: 'suspended',
        merchantFirebaseUid: 'uid-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    const app = buildApp(new DuoFaceShopService(suspendedStore), {
      firebaseUid: 'uid-1',
      role: 'merchant',
      shopId: 'shop-1',
    });

    const response = await request(app).get('/protected');
    expect(response.status).toBe(403);
  });

  it('rejects (403, not a crash) when the shop lookup throws', async () => {
    const throwingService = new DuoFaceShopService({
      get: async () => {
        throw new Error('simulated Firestore failure');
      },
      set: async () => {},
      findByCustomerAppShopId: async () => null,
      findByMerchantFirebaseUid: async () => null,
    });
    const app = buildApp(throwingService, { firebaseUid: 'uid-1', role: 'merchant', shopId: 'shop-1' });

    const response = await request(app).get('/protected');
    expect(response.status).toBe(403);
  });
});
