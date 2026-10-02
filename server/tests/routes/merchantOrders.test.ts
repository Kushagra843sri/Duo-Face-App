import express from 'express';
import request from 'supertest';

import { errorHandler } from '../../src/middleware/errorHandler';
import { createMerchantOrdersRouter } from '../../src/routes/merchant/orders';
import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import type { CustomerAppOrderProvider } from '../../src/integrations/customerApp/CustomerAppOrderProvider';
import type { CustomerAppShopProvider } from '../../src/integrations/customerApp/CustomerAppShopProvider';
import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import { DeliveryAssignmentService } from '../../src/services/deliveryAssignmentService';
import { DuoFaceShopService } from '../../src/services/duoFaceShopService';
import type { DeliveryAssignmentStore } from '../../src/integrations/firebase/FirestoreDeliveryAssignmentStore';
import { MerchantOrderService } from '../../src/services/merchantOrderService';
import { DuoFaceRoleResolver } from '../../src/services/roleResolver';
import type { RoleResolver } from '../../src/services/roleResolver';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';
import type { DuoFaceShopStore } from '../../src/integrations/firebase/FirestoreDuoFaceShopStore';

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

const now = new Date();
const failingVerifier: FirebaseIdentityVerifier = {
  verifyIdToken: async () => {
    throw new Error('invalid token');
  },
};
const unresolvedResolver: RoleResolver = { resolve: async () => null };

function createFakeAssignmentStore(initial: Record<string, Record<string, unknown>> = {}): DeliveryAssignmentStore {
  const data = new Map(Object.entries(initial));
  return {
    async get(id) {
      return data.get(id) ?? null;
    },
    async listByDriverId(driverId) {
      return [...data.values()].filter((v) => v.driverId === driverId);
    },
    async listByOrderId() {
      return [];
    },
    async listByCustomerAppShopId(shopId) {
      return [...data.values()].filter((v) => v.customerAppShopId === shopId);
    },
    async createIfNoActiveAssignmentForOrder() {
      throw new Error('not used');
    },
    async runTransaction() {
      throw new Error('not used');
    },
  };
}

function verifierFor(firebaseUid: string): FirebaseIdentityVerifier {
  return { verifyIdToken: async () => ({ firebaseUid }) };
}

function baseOrder(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    orderId: 'order-1',
    shopId: 'shop-1',
    status: 'pending',
    paymentStatus: 'paid',
    items: [{ productId: 'product-1', name: 'Amul Milk', price: 28, quantity: 2, subtotal: 56 }],
    delivery: { label: 'Home', fullAddress: '123 MG Road', phoneNumber: '+911234567890' },
    pricing: { total: 71 },
    createdAt: now,
    ...overrides,
  };
}

interface Ctx {
  verifier: FirebaseIdentityVerifier;
  roleResolver: RoleResolver;
  shopService: DuoFaceShopService;
  orderService: MerchantOrderService;
  assignmentService: DeliveryAssignmentService;
}

function buildMerchantContext(
  firebaseUid: string,
  duoFaceShopId: string,
  customerAppShopId: string,
  orders: unknown[],
  ordersById: Record<string, unknown> = {},
  assignments: Record<string, Record<string, unknown>> = {}
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
      customerAppShopId,
      createdAt: now,
      updatedAt: now,
    },
  });
  const shopProvider: CustomerAppShopProvider = {
    getShop: async (id) => (id === customerAppShopId ? { id, name: 'Test Shop' } : null),
  };
  const orderProvider: CustomerAppOrderProvider = {
    listOrdersByShopId: async () => orders,
    getOrderById: async (orderId) => ordersById[orderId] ?? null,
    markOrderDelivered: async () => {
      throw new Error('not used');
    },
  };

  return {
    verifier: verifierFor(firebaseUid),
    roleResolver: new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore)),
    shopService: new DuoFaceShopService(shopStore),
    orderService: new MerchantOrderService(orderProvider, shopProvider),
    assignmentService: new DeliveryAssignmentService(createFakeAssignmentStore(assignments)),
  };
}

function buildApp(ctx: Partial<Ctx> & { verifier: FirebaseIdentityVerifier; roleResolver: RoleResolver }) {
  const app = express();
  app.use(express.json());
  app.use(
    '/merchant/orders',
    createMerchantOrdersRouter(
      ctx.verifier,
      ctx.roleResolver,
      ctx.shopService ?? new DuoFaceShopService(createFakeShopStore()),
      ctx.orderService,
      ctx.assignmentService
    )
  );
  app.use(errorHandler);
  return app;
}

describe('Merchant order routes — authentication/authorization boundary', () => {
  it('returns 401 without an Authorization header', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1', []);
    const response = await request(buildApp(ctx)).get('/merchant/orders');
    expect(response.status).toBe(401);
  });

  it('returns 401 for an invalid Firebase token', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1', []);
    const response = await request(buildApp({ ...ctx, verifier: failingVerifier }))
      .get('/merchant/orders')
      .set('Authorization', 'Bearer bad-token');
    expect(response.status).toBe(401);
  });

  it('returns 403 for an unmapped identity', async () => {
    const response = await request(buildApp({ verifier: verifierFor('uid-1'), roleResolver: unresolvedResolver }))
      .get('/merchant/orders')
      .set('Authorization', 'Bearer good-token');
    expect(response.status).toBe(403);
  });

  it('returns 403 for a driver identity', async () => {
    const identityStore = createFakeIdentityStore({
      'uid-1': { firebaseUid: 'uid-1', role: 'driver', status: 'active', driver: { driverId: 'd-1' }, createdAt: now, updatedAt: now },
    });
    const roleResolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore));

    const response = await request(buildApp({ verifier: verifierFor('uid-1'), roleResolver }))
      .get('/merchant/orders')
      .set('Authorization', 'Bearer good-token');
    expect(response.status).toBe(403);
  });

  it('returns 409 when the merchant shop has no customerAppShopId mapping', async () => {
    const identityStore = createFakeIdentityStore({
      'uid-1': { firebaseUid: 'uid-1', role: 'merchant', status: 'active', merchant: { shopId: 'duo-shop-1' }, createdAt: now, updatedAt: now },
    });
    const shopStore = createFakeShopStore({
      'duo-shop-1': { shopId: 'duo-shop-1', name: 'X', status: 'active', merchantFirebaseUid: 'uid-1', createdAt: now, updatedAt: now },
    });
    const roleResolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore));
    const shopService = new DuoFaceShopService(shopStore);

    const response = await request(buildApp({ verifier: verifierFor('uid-1'), roleResolver, shopService }))
      .get('/merchant/orders')
      .set('Authorization', 'Bearer good-token');
    expect(response.status).toBe(409);
  });
});

describe('GET /merchant/orders — list, ownership, isolation', () => {
  it('lists only the linked shop\'s orders as safe summaries', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1', [baseOrder()]);
    const response = await request(buildApp(ctx)).get('/merchant/orders').set('Authorization', 'Bearer token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([
      { orderId: 'order-1', status: 'pending', itemCount: 1, total: 71, createdAt: now.toISOString(), deliveryAssignment: null },
    ]);
  });

  it('never returns another shop\'s orders (cross-shop isolation)', async () => {
    const merchantA = buildMerchantContext('uid-a', 'duo-shop-a', 'shop-a', [baseOrder({ orderId: 'order-a', shopId: 'shop-a' })]);
    const merchantB = buildMerchantContext('uid-b', 'duo-shop-b', 'shop-b', [baseOrder({ orderId: 'order-b', shopId: 'shop-b' })]);

    const responseA = await request(buildApp(merchantA)).get('/merchant/orders').set('Authorization', 'Bearer token');
    const responseB = await request(buildApp(merchantB)).get('/merchant/orders').set('Authorization', 'Bearer token');

    expect(responseA.body.map((o: { orderId: string }) => o.orderId)).toEqual(['order-a']);
    expect(responseB.body.map((o: { orderId: string }) => o.orderId)).toEqual(['order-b']);
  });

  it('ignores a shopId/customerAppShopId supplied via query string', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1', [baseOrder()]);
    const response = await request(buildApp(ctx))
      .get('/merchant/orders?shopId=attacker-shop&customerAppShopId=attacker-shop')
      .set('Authorization', 'Bearer token');

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].orderId).toBe('order-1');
  });
});

describe('GET /merchant/orders — deliveryAssignment state', () => {
  function assignment(overrides: Record<string, unknown>) {
    return {
      assignmentId: 'a-1',
      orderId: 'order-1',
      customerAppShopId: 'shop-1',
      driverId: 'driver-1',
      status: 'assigned',
      assignedAt: now,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  it('reports the Duo-Face assignment for an assigned order, not one inferred from order status', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1', [baseOrder(), baseOrder({ orderId: 'order-2' })], {}, {
      'a-1': assignment({ status: 'accepted' }),
    });
    const response = await request(buildApp(ctx)).get('/merchant/orders').set('Authorization', 'Bearer token');

    const byId = Object.fromEntries(response.body.map((o: { orderId: string }) => [o.orderId, o]));
    expect(byId['order-1'].deliveryAssignment).toEqual({ assignmentId: 'a-1', status: 'accepted' });
    expect(byId['order-2'].deliveryAssignment).toBeNull();
  });

  it('prefers an active assignment over an older rejected one for the same order', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1', [baseOrder()], {}, {
      'a-old': assignment({ assignmentId: 'a-old', status: 'rejected', assignedAt: new Date(now.getTime() - 1000) }),
      'a-new': assignment({ assignmentId: 'a-new', status: 'assigned' }),
    });
    const response = await request(buildApp(ctx)).get('/merchant/orders').set('Authorization', 'Bearer token');
    expect(response.body[0].deliveryAssignment).toEqual({ assignmentId: 'a-new', status: 'assigned' });
  });

  it('never surfaces another shop\'s assignment for the same orderId', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1', [baseOrder()], {}, {
      'a-x': assignment({ assignmentId: 'a-x', customerAppShopId: 'other-shop' }),
    });
    const response = await request(buildApp(ctx)).get('/merchant/orders').set('Authorization', 'Bearer token');
    expect(response.body[0].deliveryAssignment).toBeNull();
  });

  it('includes deliveryAssignment on order detail', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1', [], { 'order-1': baseOrder() }, { 'a-1': assignment({}) });
    const response = await request(buildApp(ctx)).get('/merchant/orders/order-1').set('Authorization', 'Bearer token');
    expect(response.body.deliveryAssignment).toEqual({ assignmentId: 'a-1', status: 'assigned' });
  });
});

describe('GET /merchant/orders/:orderId — detail', () => {
  it('returns full order detail for an order belonging to this shop', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1', [], { 'order-1': baseOrder() });
    const response = await request(buildApp(ctx)).get('/merchant/orders/order-1').set('Authorization', 'Bearer token');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      orderId: 'order-1',
      status: 'pending',
      paymentStatus: 'paid',
      total: 71,
      delivery: { label: 'Home', fullAddress: '123 MG Road', phoneNumber: '+911234567890' },
    });
  });

  it('returns 404 for a nonexistent order', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1', [], {});
    const response = await request(buildApp(ctx)).get('/merchant/orders/missing-order').set('Authorization', 'Bearer token');
    expect(response.status).toBe(404);
  });

  it('returns 404 (not another shop\'s order) when the order belongs to a different shop', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1', [], {
      'order-2': baseOrder({ orderId: 'order-2', shopId: 'a-different-shop' }),
    });
    const response = await request(buildApp(ctx)).get('/merchant/orders/order-2').set('Authorization', 'Bearer token');
    expect(response.status).toBe(404);
  });
});
