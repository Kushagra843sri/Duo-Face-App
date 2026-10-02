import express from 'express';
import request from 'supertest';

import { errorHandler } from '../../src/middleware/errorHandler';
import { createMerchantProductsRouter } from '../../src/routes/merchant/products';
import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import type { CustomerAppProductProvider } from '../../src/integrations/customerApp/CustomerAppProductProvider';
import type { CustomerAppShopProvider } from '../../src/integrations/customerApp/CustomerAppShopProvider';
import type { CustomerAppInventoryProvider } from '../../src/integrations/customerApp/CustomerAppInventoryProvider';
import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import { DuoFaceShopService } from '../../src/services/duoFaceShopService';
import { InventoryService } from '../../src/services/inventoryService';
import { MerchantProductCatalogService } from '../../src/services/merchantProductCatalogService';
import { DuoFaceRoleResolver } from '../../src/services/roleResolver';
import type { RoleResolver } from '../../src/services/roleResolver';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';
import type { DuoFaceShopStore } from '../../src/integrations/firebase/FirestoreDuoFaceShopStore';
import type { InventoryStore } from '../../src/integrations/firebase/FirestoreInventoryStore';

function createFakeIdentityStore(initial: Record<string, Record<string, unknown>> = {}): DuoFaceIdentityStore {
  const data = new Map(Object.entries(initial));
  return {
    async get(uid) {
      return data.get(uid) ?? null;
    },
    async set(uid, v) {
      data.set(uid, v);
    },
  };
}

function createFakeShopStore(initial: Record<string, Record<string, unknown>> = {}): DuoFaceShopStore {
  const data = new Map(Object.entries(initial));
  return {
    async get(id) {
      return data.get(id) ?? null;
    },
    async set(id, v) {
      data.set(id, v);
    },
    async findByCustomerAppShopId(customerAppShopId) {
      for (const v of data.values()) if (v.customerAppShopId === customerAppShopId) return v;
      return null;
    },
    async findByMerchantFirebaseUid(uid) {
      for (const v of data.values()) if (v.merchantFirebaseUid === uid) return v;
      return null;
    },
  };
}

function createFakeInventoryStore(initial: Record<string, Record<string, unknown>> = {}): InventoryStore {
  const data = new Map(Object.entries(initial));
  return {
    async get(id) {
      return data.get(id) ?? null;
    },
    async set(id, v) {
      data.set(id, v);
    },
    async listByShopId(shopId) {
      return [...data.values()].filter((v) => v.shopId === shopId);
    },
    async runTransaction(id, updater) {
      const current = data.get(id) ?? null;
      const next = updater(current);
      data.set(id, next);
      return next;
    },
  };
}

const unusedInventoryProductLookup: CustomerAppInventoryProvider = {
  getProduct: async () => {
    throw new Error('not used');
  },
  getStock: async () => {
    throw new Error('not used');
  },
  adjustStock: async () => {
    throw new Error('not used');
  },
};

const now = new Date();
const failingVerifier: FirebaseIdentityVerifier = {
  verifyIdToken: async () => {
    throw new Error('invalid token');
  },
};
const unresolvedResolver: RoleResolver = { resolve: async () => null };

function verifierFor(firebaseUid: string): FirebaseIdentityVerifier {
  return { verifyIdToken: async () => ({ firebaseUid }) };
}

interface Ctx {
  verifier: FirebaseIdentityVerifier;
  roleResolver: RoleResolver;
  shopService: DuoFaceShopService;
  catalogService: MerchantProductCatalogService;
}

// duoFaceShopId and customerAppShopId are deliberately different values in
// most tests below, to prove GET /merchant/products filters by the
// Customer App shop id (customerAppShopId), never by the Duo-Face shop's
// own id.
function buildMerchantContext(
  firebaseUid: string,
  duoFaceShopId: string,
  customerAppShopId: string | undefined,
  products: unknown[],
  options: { linkedShopExists?: boolean } = {}
): Ctx {
  const identityStore = createFakeIdentityStore({
    [firebaseUid]: {
      firebaseUid,
      role: 'merchant',
      status: 'active',
      merchant: { shopId: duoFaceShopId },
      createdAt: now,
      updatedAt: now,
    },
  });
  const shopStore = createFakeShopStore({
    [duoFaceShopId]: {
      shopId: duoFaceShopId,
      name: 'Test Shop',
      status: 'active',
      merchantFirebaseUid: firebaseUid,
      ...(customerAppShopId ? { customerAppShopId } : {}),
      createdAt: now,
      updatedAt: now,
    },
  });
  const productProvider: CustomerAppProductProvider = { listProductsByShopId: async () => products };
  const inventoryService = new InventoryService(createFakeInventoryStore(), unusedInventoryProductLookup);
  const linkedShopExists = options.linkedShopExists ?? true;
  const customerAppShopProvider: CustomerAppShopProvider = {
    getShop: async (id) => (linkedShopExists && id === customerAppShopId ? { id, name: 'Test Shop' } : null),
  };

  return {
    verifier: verifierFor(firebaseUid),
    roleResolver: new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore)),
    shopService: new DuoFaceShopService(shopStore),
    catalogService: new MerchantProductCatalogService(productProvider, inventoryService, customerAppShopProvider),
  };
}

function buildApp(ctx: Partial<Ctx> & { verifier: FirebaseIdentityVerifier; roleResolver: RoleResolver }) {
  const app = express();
  app.use(express.json());
  app.use(
    '/merchant/products',
    createMerchantProductsRouter(
      ctx.verifier,
      ctx.roleResolver,
      ctx.shopService ?? new DuoFaceShopService(createFakeShopStore()),
      ctx.catalogService ??
        new MerchantProductCatalogService(
          { listProductsByShopId: async () => [] },
          new InventoryService(createFakeInventoryStore(), unusedInventoryProductLookup)
        )
    )
  );
  app.use(errorHandler);
  return app;
}

describe('GET /merchant/products — authentication/authorization boundary', () => {
  it('returns 401 without an Authorization header', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1', []);
    const response = await request(buildApp(ctx)).get('/merchant/products');
    expect(response.status).toBe(401);
  });

  it('returns 401 for an invalid Firebase token', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1', []);
    const response = await request(buildApp({ ...ctx, verifier: failingVerifier }))
      .get('/merchant/products')
      .set('Authorization', 'Bearer bad-token');
    expect(response.status).toBe(401);
  });

  it('returns 403 for an unmapped identity', async () => {
    const response = await request(buildApp({ verifier: verifierFor('uid-1'), roleResolver: unresolvedResolver }))
      .get('/merchant/products')
      .set('Authorization', 'Bearer good-token');
    expect(response.status).toBe(403);
  });

  it('returns 403 for a driver identity', async () => {
    const identityStore = createFakeIdentityStore({
      'uid-1': { firebaseUid: 'uid-1', role: 'driver', status: 'active', driver: { driverId: 'd-1' }, createdAt: now, updatedAt: now },
    });
    const roleResolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore));

    const response = await request(buildApp({ verifier: verifierFor('uid-1'), roleResolver }))
      .get('/merchant/products')
      .set('Authorization', 'Bearer good-token');
    expect(response.status).toBe(403);
  });
});

describe('GET /merchant/products — catalog + ownership', () => {
  it('filters products by the shop\'s customerAppShopId, not its Duo-Face shopId', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1', [
      { id: 'product-1', shopId: 'shop-1', name: 'Amul Milk', price: 28, inStock: true },
    ]);

    const response = await request(buildApp(ctx)).get('/merchant/products').set('Authorization', 'Bearer token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      { productId: 'product-1', name: 'Amul Milk', price: 28, inStock: true, inventory: null },
    ]);
  });

  it('returns 409 (never a silent empty list) when the shop has no customerAppShopId mapping yet', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', undefined, [
      { id: 'product-1', shopId: 'shop-1', name: 'Amul Milk', price: 28, inStock: true },
    ]);

    const response = await request(buildApp(ctx)).get('/merchant/products').set('Authorization', 'Bearer token');

    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/not linked/i);
  });

  it('returns a distinct 409 when customerAppShopId is set but the linked Customer App shop no longer exists', async () => {
    const ctx = buildMerchantContext(
      'uid-1',
      'duo-shop-1',
      'shop-1',
      [{ id: 'product-1', shopId: 'shop-1', name: 'Amul Milk', price: 28, inStock: true }],
      { linkedShopExists: false }
    );

    const response = await request(buildApp(ctx)).get('/merchant/products').set('Authorization', 'Bearer token');

    expect(response.status).toBe(409);
    expect(response.body.message).toMatch(/no longer exists/i);
    expect(response.body.message).not.toMatch(/not linked/i);
  });

  it('ignores a customerAppShopId supplied via query string or body — the linked shop\'s own mapping is always used', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1', [
      { id: 'product-1', shopId: 'shop-1', name: 'Amul Milk', price: 28, inStock: true },
    ]);

    const viaQuery = await request(buildApp(ctx))
      .get('/merchant/products?customerAppShopId=attacker-shop')
      .set('Authorization', 'Bearer token');
    const viaBody = await request(buildApp(ctx))
      .get('/merchant/products')
      .set('Authorization', 'Bearer token')
      .send({ customerAppShopId: 'attacker-shop' });

    // Still resolves against the shop's own real mapping ('shop-1'), not
    // the attacker-supplied value — GET /merchant/products has no code
    // path that reads a shopId from the request at all.
    for (const response of [viaQuery, viaBody]) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual([
        { productId: 'product-1', name: 'Amul Milk', price: 28, inStock: true, inventory: null },
      ]);
    }
  });

  it('never returns another shop\'s products, and never exposes raw Firestore fields', async () => {
    const merchantA = buildMerchantContext('uid-a', 'duo-shop-a', 'shop-a', [
      { id: 'product-a', shopId: 'shop-a', name: 'A Product', price: 10, inStock: true },
    ]);
    const merchantB = buildMerchantContext('uid-b', 'duo-shop-b', 'shop-b', [
      { id: 'product-b', shopId: 'shop-b', name: 'B Product', price: 20, inStock: false },
    ]);

    const responseA = await request(buildApp(merchantA)).get('/merchant/products').set('Authorization', 'Bearer token');
    const responseB = await request(buildApp(merchantB)).get('/merchant/products').set('Authorization', 'Bearer token');

    expect(responseA.body).toEqual([{ productId: 'product-a', name: 'A Product', price: 10, inStock: true, inventory: null }]);
    expect(responseB.body).toEqual([{ productId: 'product-b', name: 'B Product', price: 20, inStock: false, inventory: null }]);
    // No leakage of categoryId/description/imageUrl/isActive/createdAt or shopId itself.
    expect(Object.keys(responseA.body[0])).toEqual(['productId', 'name', 'price', 'inStock', 'inventory']);
  });
});
