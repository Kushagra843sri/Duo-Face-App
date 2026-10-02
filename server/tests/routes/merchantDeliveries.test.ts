import express from 'express';
import request from 'supertest';

import { AppError, errorHandler } from '../../src/middleware/errorHandler';
import { createMerchantDeliveriesRouter } from '../../src/routes/merchant/deliveries';
import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import { ActiveAssignmentConflictError } from '../../src/integrations/firebase/FirestoreDeliveryAssignmentStore';
import type { DeliveryAssignmentStore } from '../../src/integrations/firebase/FirestoreDeliveryAssignmentStore';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';
import type { DuoFaceShopStore } from '../../src/integrations/firebase/FirestoreDuoFaceShopStore';
import { DeliveryAssignmentService } from '../../src/services/deliveryAssignmentService';
import type { DriverDispatchService } from '../../src/services/driverDispatchService';
import { DriverService } from '../../src/services/driverService';
import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import { DuoFaceShopService } from '../../src/services/duoFaceShopService';
import { DuoFaceRoleResolver } from '../../src/services/roleResolver';
import type { RoleResolver } from '../../src/services/roleResolver';
import type { CustomerAppOrderProvider } from '../../src/integrations/customerApp/CustomerAppOrderProvider';
import type { DuoFaceDriverStore } from '../../src/integrations/firebase/FirestoreDuoFaceDriverStore';

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
    async createIfNoActiveAssignmentForOrder(id, orderId, activeStatuses, dataToWrite) {
      const hasActive = [...data.values()].some((v) => v.orderId === orderId && activeStatuses.includes(v.status as string));
      if (hasActive) throw new ActiveAssignmentConflictError('active assignment already exists');
      data.set(id, dataToWrite);
    },
    async runTransaction(id, updater) {
      const current = data.get(id) ?? null;
      const next = updater(current);
      data.set(id, next);
      return next;
    },
  };
}

const now = new Date();

function fakeOrderProvider(orders: Record<string, unknown> = {}): CustomerAppOrderProvider {
  return {
    listOrdersByShopId: async () => [],
    getOrderById: async (orderId) => orders[orderId] ?? null,
    markOrderDelivered: async () => {
      throw new Error('not used');
    },
  };
}

function fakeDriverStore(initial: Record<string, Record<string, unknown>> = {}): DuoFaceDriverStore {
  const data = new Map(Object.entries(initial));
  return {
    async get(id) {
      return data.get(id) ?? null;
    },
    async set(id, v) {
      data.set(id, v);
    },
    async listByStatus(status) {
      return [...data.values()].filter((v) => v.status === status);
    },
    async findByFirebaseUid(uid) {
      for (const v of data.values()) if (v.firebaseUid === uid) return v;
      return null;
    },
  };
}

function activeDriver(overrides: Partial<Record<string, unknown>> = {}) {
  return { driverId: 'driver-1', firebaseUid: 'driver-uid-1', name: 'Ravi Kumar', status: 'active', createdAt: now, updatedAt: now, ...overrides };
}

function verifierFor(firebaseUid: string): FirebaseIdentityVerifier {
  return { verifyIdToken: async () => ({ firebaseUid }) };
}

function baseAssignment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    assignmentId: 'assignment-1',
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

interface Ctx {
  verifier: FirebaseIdentityVerifier;
  roleResolver: RoleResolver;
  shopService: DuoFaceShopService;
  assignmentService: DeliveryAssignmentService;
}

function buildMerchantContext(
  firebaseUid: string,
  duoFaceShopId: string,
  customerAppShopId: string | undefined,
  assignments: Record<string, Record<string, unknown>> = {},
  orders: Record<string, unknown> = {},
  drivers: Record<string, Record<string, unknown>> = {}
): Ctx {
  const identityStore = createFakeIdentityStore({
    [firebaseUid]: { firebaseUid, role: 'merchant', status: 'active', merchant: { shopId: duoFaceShopId }, createdAt: now, updatedAt: now },
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
  const assignmentStore = createFakeAssignmentStore(assignments);

  return {
    verifier: verifierFor(firebaseUid),
    roleResolver: new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore)),
    shopService: new DuoFaceShopService(shopStore),
    assignmentService: new DeliveryAssignmentService(assignmentStore, new DriverService(fakeDriverStore(drivers)), fakeOrderProvider(orders)),
  };
}

function buildApp(ctx: Ctx, dispatch?: DriverDispatchService) {
  const app = express();
  app.use(express.json());
  app.use(
    '/merchant/deliveries',
    createMerchantDeliveriesRouter(ctx.verifier, ctx.roleResolver, ctx.shopService, ctx.assignmentService, undefined, dispatch)
  );
  app.use(errorHandler);
  return app;
}

describe('GET /merchant/deliveries', () => {
  it('returns 409 when the merchant shop has no customerAppShopId mapping', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', undefined);
    const response = await request(buildApp(ctx)).get('/merchant/deliveries').set('Authorization', 'Bearer token');
    expect(response.status).toBe(409);
  });

  it('lists only the linked shop\'s delivery assignments', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1', { 'assignment-1': baseAssignment() });
    const response = await request(buildApp(ctx)).get('/merchant/deliveries').set('Authorization', 'Bearer token');

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].assignmentId).toBe('assignment-1');
  });

  it('never returns another shop\'s delivery assignments (cross-shop isolation)', async () => {
    const assignments = {
      'assignment-a': baseAssignment({ assignmentId: 'assignment-a', customerAppShopId: 'shop-a' }),
      'assignment-b': baseAssignment({ assignmentId: 'assignment-b', customerAppShopId: 'shop-b' }),
    };
    const merchantA = buildMerchantContext('uid-a', 'duo-shop-a', 'shop-a', assignments);
    const merchantB = buildMerchantContext('uid-b', 'duo-shop-b', 'shop-b', assignments);

    const responseA = await request(buildApp(merchantA)).get('/merchant/deliveries').set('Authorization', 'Bearer token');
    const responseB = await request(buildApp(merchantB)).get('/merchant/deliveries').set('Authorization', 'Bearer token');

    expect(responseA.body.map((a: { assignmentId: string }) => a.assignmentId)).toEqual(['assignment-a']);
    expect(responseB.body.map((a: { assignmentId: string }) => a.assignmentId)).toEqual(['assignment-b']);
  });
});

describe('POST /merchant/deliveries (request a driver)', () => {
  function dispatchStub(result: () => Promise<unknown>) {
    const calls: Array<{ shopId: string | undefined; orderId: string }> = [];
    const service = {
      requestDriver: async (shop: { customerAppShopId?: string }, orderId: string) => {
        calls.push({ shopId: shop.customerAppShopId, orderId });
        return result();
      },
    } as unknown as DriverDispatchService;
    return { service, calls };
  }

  function post(ctx: Ctx, dispatch: DriverDispatchService, body: Record<string, unknown>) {
    return request(buildApp(ctx, dispatch)).post('/merchant/deliveries').set('Authorization', 'Bearer token').send(body);
  }

  it('raises the request for the merchant own linked shop and returns the assigned driver (201)', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1', {}, {}, { 'driver-1': activeDriver() });
    const { service, calls } = dispatchStub(async () => baseAssignment());
    const response = await post(ctx, service, { orderId: 'order-1' });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ orderId: 'order-1', driverId: 'driver-1', driverName: 'Ravi Kumar', status: 'assigned' });
    expect(calls).toEqual([{ shopId: 'shop-1', orderId: 'order-1' }]);
  });

  it.each([
    ['driverId', { orderId: 'order-1', driverId: 'driver-1' }],
    ['customerAppShopId', { orderId: 'order-1', customerAppShopId: 'attacker-shop' }],
  ])('rejects a client-supplied %s with 400 and never dispatches', async (_name, body) => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1');
    const { service, calls } = dispatchStub(async () => baseAssignment());
    const response = await post(ctx, service, body);
    expect(response.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('requires an orderId', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1');
    const { service } = dispatchStub(async () => baseAssignment());
    expect((await post(ctx, service, {})).status).toBe(400);
  });

  it('passes through "no driver available" as 409', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1');
    const { service } = dispatchStub(async () => {
      throw new AppError(409, 'No driver available nearby right now.');
    });
    const response = await post(ctx, service, { orderId: 'order-1' });
    expect(response.status).toBe(409);
    expect(response.body.message).toBe('No driver available nearby right now.');
  });

  it('returns 404 for an order that is missing or belongs to another shop', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1');
    const { service } = dispatchStub(async () => {
      throw new AppError(404, 'Order not found.');
    });
    expect((await post(ctx, service, { orderId: 'order-9' })).status).toBe(404);
  });

});

describe('GET /merchant/deliveries/:assignmentId', () => {
  it('returns an assignment belonging to this shop', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1', { 'assignment-1': baseAssignment() });
    const response = await request(buildApp(ctx)).get('/merchant/deliveries/assignment-1').set('Authorization', 'Bearer token');
    expect(response.status).toBe(200);
    expect(response.body.assignmentId).toBe('assignment-1');
  });

  it('returns 404 (not leaking existence) for another shop\'s assignment', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1', {
      'assignment-2': baseAssignment({ assignmentId: 'assignment-2', customerAppShopId: 'a-different-shop' }),
    });
    const response = await request(buildApp(ctx)).get('/merchant/deliveries/assignment-2').set('Authorization', 'Bearer token');
    expect(response.status).toBe(404);
  });

  it('returns 404 for a nonexistent assignment', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1');
    const response = await request(buildApp(ctx)).get('/merchant/deliveries/missing').set('Authorization', 'Bearer token');
    expect(response.status).toBe(404);
  });
});

describe('Merchant delivery DTO', () => {
  it('enriches with driver name/phone, serializes timestamps as ISO, and never leaks the driver firebaseUid', async () => {
    const firestoreTimestamp = { toDate: () => now };
    const ctx = buildMerchantContext(
      'uid-1',
      'duo-shop-1',
      'shop-1',
      { 'assignment-1': baseAssignment({ status: 'accepted', assignedAt: firestoreTimestamp, acceptedAt: firestoreTimestamp }) },
      {},
      { 'driver-1': activeDriver({ phoneNumber: '+911234567890' }) }
    );
    const response = await request(buildApp(ctx)).get('/merchant/deliveries/assignment-1').set('Authorization', 'Bearer token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      assignmentId: 'assignment-1',
      orderId: 'order-1',
      customerAppShopId: 'shop-1',
      driverId: 'driver-1',
      driverName: 'Ravi Kumar',
      driverPhoneNumber: '+911234567890',
      status: 'accepted',
      assignedAt: now.toISOString(),
      acceptedAt: now.toISOString(),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    expect(JSON.stringify(response.body)).not.toContain('driver-uid-1');
  });

  it('shows driverName null (not a failure) when the driver profile no longer exists', async () => {
    const ctx = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1', { 'assignment-1': baseAssignment() });
    const response = await request(buildApp(ctx)).get('/merchant/deliveries').set('Authorization', 'Bearer token');
    expect(response.status).toBe(200);
    expect(response.body[0].driverName).toBeNull();
  });

  it('rejects a driver principal on the merchant endpoints (cross-role)', async () => {
    const base = buildMerchantContext('uid-1', 'duo-shop-1', 'shop-1');
    const driverResolver = new DuoFaceRoleResolver(
      new DuoFaceIdentityService(
        createFakeIdentityStore({
          'uid-1': { firebaseUid: 'uid-1', role: 'driver', status: 'active', driver: { driverId: 'driver-1' }, createdAt: now, updatedAt: now },
        })
      )
    );
    const app = buildApp({ ...base, roleResolver: driverResolver });
    const list = await request(app).get('/merchant/deliveries').set('Authorization', 'Bearer token');
    const create = await request(app)
      .post('/merchant/deliveries')
      .set('Authorization', 'Bearer token')
      .send({ orderId: 'order-1' });
    expect(list.status).toBe(403);
    expect(create.status).toBe(403);
  });
});
