import express from 'express';
import request from 'supertest';

import { createMerchantInventoryRouter } from '../../src/routes/merchant/inventory';
import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import type { CustomerAppInventoryProvider } from '../../src/integrations/customerApp/CustomerAppInventoryProvider';
import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import { DuoFaceShopService } from '../../src/services/duoFaceShopService';
import { InventoryService } from '../../src/services/inventoryService';
import { DuoFaceRoleResolver } from '../../src/services/roleResolver';
import type { RoleResolver } from '../../src/services/roleResolver';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';
import type { DuoFaceShopStore } from '../../src/integrations/firebase/FirestoreDuoFaceShopStore';
import type { InventoryStore } from '../../src/integrations/firebase/FirestoreInventoryStore';

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

function createFakeInventoryStore(initial: Record<string, Record<string, unknown>> = {}): InventoryStore {
  const data = new Map(Object.entries(initial));
  return {
    async get(inventoryId) {
      return data.get(inventoryId) ?? null;
    },
    async set(inventoryId, value) {
      data.set(inventoryId, value);
    },
    async listByShopId(shopId) {
      return [...data.values()].filter((v) => v.shopId === shopId);
    },
    async runTransaction(inventoryId, updater) {
      const current = data.get(inventoryId) ?? null;
      const next = updater(current);
      data.set(inventoryId, next);
      return next;
    },
  };
}

const alwaysFoundProductLookup: CustomerAppInventoryProvider = {
  getProduct: async () => ({ id: 'product-1', name: 'Some Product' }),
  getStock: async () => {
    throw new Error('not used');
  },
  adjustStock: async () => {
    throw new Error('not used');
  },
};

const now = new Date();

function verifierFor(firebaseUid: string): FirebaseIdentityVerifier {
  return { verifyIdToken: async () => ({ firebaseUid }) };
}

const failingVerifier: FirebaseIdentityVerifier = {
  verifyIdToken: async () => {
    throw new Error('invalid token');
  },
};

const unresolvedResolver: RoleResolver = { resolve: async () => null };

interface MerchantContext {
  verifier: FirebaseIdentityVerifier;
  roleResolver: RoleResolver;
  shopService: DuoFaceShopService;
  inventoryService: InventoryService;
}

function buildMerchantContext(firebaseUid: string, shopId: string): MerchantContext {
  const identityStore = createFakeIdentityStore({
    [firebaseUid]: {
      firebaseUid,
      role: 'merchant',
      status: 'active',
      merchant: { shopId },
      createdAt: now,
      updatedAt: now,
    },
  });
  const shopStore = createFakeShopStore({
    [shopId]: {
      shopId,
      name: 'Test Shop',
      status: 'active',
      merchantFirebaseUid: firebaseUid,
      createdAt: now,
      updatedAt: now,
    },
  });
  const inventoryStore = createFakeInventoryStore();

  return {
    verifier: verifierFor(firebaseUid),
    roleResolver: new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore)),
    shopService: new DuoFaceShopService(shopStore),
    inventoryService: new InventoryService(inventoryStore, alwaysFoundProductLookup),
  };
}

function buildApp(ctx: {
  verifier: FirebaseIdentityVerifier;
  roleResolver: RoleResolver;
  shopService?: DuoFaceShopService;
  inventoryService?: InventoryService;
}) {
  const app = express();
  app.use(express.json());
  app.use(
    '/merchant/inventory',
    createMerchantInventoryRouter(
      ctx.verifier,
      ctx.roleResolver,
      ctx.shopService ?? new DuoFaceShopService(createFakeShopStore()),
      ctx.inventoryService ?? new InventoryService(createFakeInventoryStore(), alwaysFoundProductLookup)
    )
  );
  return app;
}

describe('Merchant inventory routes — authentication/authorization boundary', () => {
  it('returns 401 without an Authorization header', async () => {
    const ctx = buildMerchantContext('uid-1', 'shop-1');
    const response = await request(buildApp(ctx)).get('/merchant/inventory');
    expect(response.status).toBe(401);
  });

  it('returns 401 for an invalid Firebase token', async () => {
    const ctx = buildMerchantContext('uid-1', 'shop-1');
    const response = await request(buildApp({ ...ctx, verifier: failingVerifier }))
      .get('/merchant/inventory')
      .set('Authorization', 'Bearer bad-token');
    expect(response.status).toBe(401);
  });

  it('returns 403 for an unmapped identity', async () => {
    const response = await request(buildApp({ verifier: verifierFor('uid-1'), roleResolver: unresolvedResolver }))
      .get('/merchant/inventory')
      .set('Authorization', 'Bearer good-token');
    expect(response.status).toBe(403);
  });

  it('returns 403 for a driver identity', async () => {
    const identityStore = createFakeIdentityStore({
      'uid-1': { firebaseUid: 'uid-1', role: 'driver', status: 'active', driver: { driverId: 'd-1' }, createdAt: now, updatedAt: now },
    });
    const roleResolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore));

    const response = await request(buildApp({ verifier: verifierFor('uid-1'), roleResolver }))
      .get('/merchant/inventory')
      .set('Authorization', 'Bearer good-token');
    expect(response.status).toBe(403);
  });
});

describe('Merchant inventory routes — ownership', () => {
  it('a merchant can list and create inventory for their own shop', async () => {
    const ctx = buildMerchantContext('uid-1', 'shop-1');
    const app = buildApp(ctx);

    const created = await request(app)
      .post('/merchant/inventory')
      .set('Authorization', 'Bearer token')
      .send({ productId: 'product-1', quantity: 10 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ shopId: 'shop-1', productId: 'product-1', quantity: 10 });

    const listed = await request(app).get('/merchant/inventory').set('Authorization', 'Bearer token');
    expect(listed.status).toBe(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].shopId).toBe('shop-1');
  });

  it('a merchant cannot see another shop\'s inventory, even via the same route', async () => {
    const merchantA = buildMerchantContext('uid-a', 'shop-a');
    const appA = buildApp(merchantA);
    await request(appA)
      .post('/merchant/inventory')
      .set('Authorization', 'Bearer token')
      .send({ productId: 'product-1', quantity: 10 });

    // A completely separate merchant, separate shop, separate inventory store.
    const merchantB = buildMerchantContext('uid-b', 'shop-b');
    const appB = buildApp(merchantB);
    const listedByB = await request(appB).get('/merchant/inventory').set('Authorization', 'Bearer token');

    expect(listedByB.status).toBe(200);
    expect(listedByB.body).toHaveLength(0); // B's own (empty) inventory, never A's shop-a data
  });

  it('ignores a shopId supplied in the request body on create', async () => {
    const ctx = buildMerchantContext('uid-1', 'shop-1');
    const response = await request(buildApp(ctx))
      .post('/merchant/inventory')
      .set('Authorization', 'Bearer token')
      .send({ productId: 'product-1', quantity: 10, shopId: 'attacker-shop' });

    expect(response.status).toBe(201);
    expect(response.body.shopId).toBe('shop-1'); // from the verified shop context, not the body
  });

  it('ignores a shopId supplied as a query parameter', async () => {
    const ctx = buildMerchantContext('uid-1', 'shop-1');
    const response = await request(buildApp(ctx))
      .get('/merchant/inventory?shopId=attacker-shop')
      .set('Authorization', 'Bearer token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]); // shop-1's (empty) inventory, query param has no effect
  });
});

describe('Merchant inventory routes — CRUD', () => {
  it('creates, retrieves, sets quantity, adjusts quantity, and disables inventory', async () => {
    const ctx = buildMerchantContext('uid-1', 'shop-1');
    const app = buildApp(ctx);
    const auth = ['Authorization', 'Bearer token'] as const;

    await request(app).post('/merchant/inventory').set(...auth).send({ productId: 'product-1', quantity: 10 });

    const got = await request(app).get('/merchant/inventory/product-1').set(...auth);
    expect(got.status).toBe(200);
    expect(got.body.quantity).toBe(10);

    const afterSet = await request(app)
      .patch('/merchant/inventory/product-1/quantity')
      .set(...auth)
      .send({ quantity: 25 });
    expect(afterSet.status).toBe(200);
    expect(afterSet.body.quantity).toBe(25);

    const afterAdjust = await request(app)
      .post('/merchant/inventory/product-1/adjust')
      .set(...auth)
      .send({ delta: -5 });
    expect(afterAdjust.status).toBe(200);
    expect(afterAdjust.body.quantity).toBe(20);

    const afterDisable = await request(app).patch('/merchant/inventory/product-1/disable').set(...auth);
    expect(afterDisable.status).toBe(200);
    expect(afterDisable.body.status).toBe('disabled');
  });

  it('returns 404 for a product with no inventory record', async () => {
    const ctx = buildMerchantContext('uid-1', 'shop-1');
    const response = await request(buildApp(ctx)).get('/merchant/inventory/missing-product').set('Authorization', 'Bearer token');
    expect(response.status).toBe(404);
  });

  it('returns 409 when adjusting disabled inventory', async () => {
    const ctx = buildMerchantContext('uid-1', 'shop-1');
    const app = buildApp(ctx);
    const auth = ['Authorization', 'Bearer token'] as const;

    await request(app).post('/merchant/inventory').set(...auth).send({ productId: 'product-1', quantity: 10 });
    await request(app).patch('/merchant/inventory/product-1/disable').set(...auth);

    const response = await request(app)
      .post('/merchant/inventory/product-1/adjust')
      .set(...auth)
      .send({ delta: 1 });
    expect(response.status).toBe(409);
  });

  it('returns 409 when an adjustment would make quantity negative', async () => {
    const ctx = buildMerchantContext('uid-1', 'shop-1');
    const app = buildApp(ctx);
    const auth = ['Authorization', 'Bearer token'] as const;

    await request(app).post('/merchant/inventory').set(...auth).send({ productId: 'product-1', quantity: 5 });

    const response = await request(app)
      .post('/merchant/inventory/product-1/adjust')
      .set(...auth)
      .send({ delta: -6 });
    expect(response.status).toBe(409);
  });
});

describe('Merchant inventory routes — request validation', () => {
  const ctx = buildMerchantContext('uid-1', 'shop-1');
  const app = buildApp(ctx);
  const auth = ['Authorization', 'Bearer token'] as const;

  it('rejects a negative quantity on create', async () => {
    const response = await request(app).post('/merchant/inventory').set(...auth).send({ productId: 'p', quantity: -1 });
    expect(response.status).toBe(400);
  });

  it('rejects a non-integer quantity on create', async () => {
    const response = await request(app).post('/merchant/inventory').set(...auth).send({ productId: 'p', quantity: 1.5 });
    expect(response.status).toBe(400);
  });

  it('accepts a zero quantity on create', async () => {
    const response = await request(app).post('/merchant/inventory').set(...auth).send({ productId: 'zero-product', quantity: 0 });
    expect(response.status).toBe(201);
  });

  it('rejects an empty productId on create', async () => {
    const response = await request(app).post('/merchant/inventory').set(...auth).send({ productId: '', quantity: 1 });
    expect(response.status).toBe(400);
  });

  it('rejects a zero delta on adjust', async () => {
    await request(app).post('/merchant/inventory').set(...auth).send({ productId: 'adjust-me', quantity: 10 });
    const response = await request(app)
      .post('/merchant/inventory/adjust-me/adjust')
      .set(...auth)
      .send({ delta: 0 });
    expect(response.status).toBe(400);
  });

  it('rejects a non-integer delta on adjust', async () => {
    const response = await request(app)
      .post('/merchant/inventory/adjust-me/adjust')
      .set(...auth)
      .send({ delta: 1.5 });
    expect(response.status).toBe(400);
  });
});
