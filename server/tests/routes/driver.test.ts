import express from 'express';
import request from 'supertest';

import { errorHandler } from '../../src/middleware/errorHandler';
import { createDriverRouter } from '../../src/routes/driver';
import { createDriverAssignmentsRouter } from '../../src/routes/driver/assignments';
import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import type { DeliveryAssignmentStore } from '../../src/integrations/firebase/FirestoreDeliveryAssignmentStore';
import type { DuoFaceDriverStore } from '../../src/integrations/firebase/FirestoreDuoFaceDriverStore';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';
import { DeliveryAssignmentService } from '../../src/services/deliveryAssignmentService';
import type { DeliveryProofService } from '../../src/services/deliveryProofService';
import { DriverService } from '../../src/services/driverService';
import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import { DuoFaceRoleResolver } from '../../src/services/roleResolver';
import type { RoleResolver } from '../../src/services/roleResolver';
import type { CustomerAppOrderProvider } from '../../src/integrations/customerApp/CustomerAppOrderProvider';

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

function createFakeDriverStore(initial: Record<string, Record<string, unknown>> = {}): DuoFaceDriverStore {
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
      if (hasActive) throw new Error('active assignment already exists');
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
const failingVerifier: FirebaseIdentityVerifier = {
  verifyIdToken: async () => {
    throw new Error('invalid token');
  },
};
const unresolvedResolver: RoleResolver = { resolve: async () => null };
const unusedOrderProvider: CustomerAppOrderProvider = {
  listOrdersByShopId: async () => [],
  getOrderById: async () => null,
  markOrderDelivered: async () => {
    throw new Error('not used');
  },
};

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
  driverService: DriverService;
  assignmentService: DeliveryAssignmentService;
}

function buildDriverContext(
  firebaseUid: string,
  driverId: string,
  assignments: Record<string, Record<string, unknown>> = {}
): Ctx {
  const identityStore = createFakeIdentityStore({
    [firebaseUid]: { firebaseUid, role: 'driver', status: 'active', driver: { driverId }, createdAt: now, updatedAt: now },
  });
  const driverStore = createFakeDriverStore({
    [driverId]: { driverId, firebaseUid, name: 'Ravi Kumar', status: 'active', createdAt: now, updatedAt: now },
  });
  const assignmentStore = createFakeAssignmentStore(assignments);

  return {
    verifier: verifierFor(firebaseUid),
    roleResolver: new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore)),
    driverService: new DriverService(driverStore),
    assignmentService: new DeliveryAssignmentService(assignmentStore, new DriverService(driverStore), unusedOrderProvider),
  };
}

function buildApp(ctx: Partial<Ctx> & { verifier: FirebaseIdentityVerifier; roleResolver: RoleResolver }, proofService?: DeliveryProofService) {
  const app = express();
  app.use(express.json());
  app.use('/driver', createDriverRouter(ctx.verifier, ctx.roleResolver, ctx.driverService));
  app.use(
    '/driver/assignments',
    createDriverAssignmentsRouter(ctx.verifier, ctx.roleResolver, ctx.driverService, ctx.assignmentService, undefined, proofService)
  );
  app.use(errorHandler);
  return app;
}

describe('Driver routes — authentication/authorization boundary', () => {
  it('returns 401 without an Authorization header', async () => {
    const ctx = buildDriverContext('uid-1', 'driver-1');
    const response = await request(buildApp(ctx)).get('/driver/me');
    expect(response.status).toBe(401);
  });

  it('returns 401 for an invalid Firebase token', async () => {
    const ctx = buildDriverContext('uid-1', 'driver-1');
    const response = await request(buildApp({ ...ctx, verifier: failingVerifier }))
      .get('/driver/me')
      .set('Authorization', 'Bearer bad-token');
    expect(response.status).toBe(401);
  });

  it('returns 403 for an unmapped identity', async () => {
    const response = await request(buildApp({ verifier: verifierFor('uid-1'), roleResolver: unresolvedResolver }))
      .get('/driver/me')
      .set('Authorization', 'Bearer good-token');
    expect(response.status).toBe(403);
  });

  it('returns 403 for a merchant identity', async () => {
    const identityStore = createFakeIdentityStore({
      'uid-1': { firebaseUid: 'uid-1', role: 'merchant', status: 'active', merchant: { shopId: 'shop-1' }, createdAt: now, updatedAt: now },
    });
    const roleResolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore));

    const response = await request(buildApp({ verifier: verifierFor('uid-1'), roleResolver }))
      .get('/driver/me')
      .set('Authorization', 'Bearer good-token');
    expect(response.status).toBe(403);
  });
});

describe('GET /driver/me', () => {
  it('returns the authenticated driver profile', async () => {
    const ctx = buildDriverContext('uid-1', 'driver-1');
    const response = await request(buildApp(ctx)).get('/driver/me').set('Authorization', 'Bearer token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ firebaseUid: 'uid-1', role: 'driver', driverId: 'driver-1', name: 'Ravi Kumar', status: 'active' });
  });

  it('includes phoneNumber when the driver profile has one', async () => {
    const identityStore = createFakeIdentityStore({
      'uid-1': { firebaseUid: 'uid-1', role: 'driver', status: 'active', driver: { driverId: 'driver-1' }, createdAt: now, updatedAt: now },
    });
    const driverStore = createFakeDriverStore({
      'driver-1': { driverId: 'driver-1', firebaseUid: 'uid-1', name: 'Ravi Kumar', phoneNumber: '+911234567890', status: 'active', createdAt: now, updatedAt: now },
    });
    const roleResolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore));
    const driverService = new DriverService(driverStore);

    const response = await request(buildApp({ verifier: verifierFor('uid-1'), roleResolver, driverService }))
      .get('/driver/me')
      .set('Authorization', 'Bearer token');

    expect(response.status).toBe(200);
    expect(response.body.phoneNumber).toBe('+911234567890');
  });
});

describe('GET /driver/assignments — list, ownership, isolation', () => {
  it('lists only this driver\'s assignments', async () => {
    const ctx = buildDriverContext('uid-1', 'driver-1', { 'assignment-1': baseAssignment() });
    const response = await request(buildApp(ctx)).get('/driver/assignments').set('Authorization', 'Bearer token');

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].assignmentId).toBe('assignment-1');
  });

  it('never returns another driver\'s assignments (cross-driver isolation)', async () => {
    const assignments = {
      'assignment-a': baseAssignment({ assignmentId: 'assignment-a', driverId: 'driver-a' }),
      'assignment-b': baseAssignment({ assignmentId: 'assignment-b', driverId: 'driver-b' }),
    };
    const driverA = buildDriverContext('uid-a', 'driver-a', assignments);
    const driverB = buildDriverContext('uid-b', 'driver-b', assignments);

    const responseA = await request(buildApp(driverA)).get('/driver/assignments').set('Authorization', 'Bearer token');
    const responseB = await request(buildApp(driverB)).get('/driver/assignments').set('Authorization', 'Bearer token');

    expect(responseA.body.map((a: { assignmentId: string }) => a.assignmentId)).toEqual(['assignment-a']);
    expect(responseB.body.map((a: { assignmentId: string }) => a.assignmentId)).toEqual(['assignment-b']);
  });

  it('ignores a driverId supplied via query string', async () => {
    const ctx = buildDriverContext('uid-1', 'driver-1', {
      'assignment-1': baseAssignment(),
      'assignment-attacker': baseAssignment({ assignmentId: 'assignment-attacker', driverId: 'attacker-driver' }),
    });
    const response = await request(buildApp(ctx))
      .get('/driver/assignments?driverId=attacker-driver')
      .set('Authorization', 'Bearer token');

    expect(response.status).toBe(200);
    expect(response.body).toHaveLength(1);
    expect(response.body[0].assignmentId).toBe('assignment-1');
  });
});

describe('GET /driver/assignments/:assignmentId — detail', () => {
  it('returns the assignment when it belongs to this driver', async () => {
    const ctx = buildDriverContext('uid-1', 'driver-1', { 'assignment-1': baseAssignment() });
    const response = await request(buildApp(ctx)).get('/driver/assignments/assignment-1').set('Authorization', 'Bearer token');

    expect(response.status).toBe(200);
    expect(response.body.assignmentId).toBe('assignment-1');
  });

  it('returns 404 for a nonexistent assignment', async () => {
    const ctx = buildDriverContext('uid-1', 'driver-1');
    const response = await request(buildApp(ctx)).get('/driver/assignments/missing').set('Authorization', 'Bearer token');
    expect(response.status).toBe(404);
  });

  it('returns 404 (not leaking existence) for another driver\'s assignment', async () => {
    const ctx = buildDriverContext('uid-1', 'driver-1', {
      'assignment-2': baseAssignment({ assignmentId: 'assignment-2', driverId: 'a-different-driver' }),
    });
    const response = await request(buildApp(ctx)).get('/driver/assignments/assignment-2').set('Authorization', 'Bearer token');
    expect(response.status).toBe(404);
  });
});

describe('POST /driver/assignments/:assignmentId/accept|reject|pickup|deliver', () => {
  it('walks a valid assignment through the full lifecycle', async () => {
    const ctx = buildDriverContext('uid-1', 'driver-1', { 'assignment-1': baseAssignment() });
    // Proof of arrival is covered in deliveryProof.test.ts; here it just completes the transition.
    const proofStub = { deliver: async (_d: unknown, id: string) => ctx.assignmentService!.markDelivered(id, 'driver-1') } as unknown as DeliveryProofService;
    const app = buildApp(ctx, proofStub);

    const accepted = await request(app).post('/driver/assignments/assignment-1/accept').set('Authorization', 'Bearer token');
    expect(accepted.status).toBe(200);
    expect(accepted.body.status).toBe('accepted');

    const pickedUp = await request(app).post('/driver/assignments/assignment-1/pickup').set('Authorization', 'Bearer token');
    expect(pickedUp.status).toBe(200);
    expect(pickedUp.body.status).toBe('picked_up');

    const noProof = await request(app).post('/driver/assignments/assignment-1/deliver').set('Authorization', 'Bearer token');
    expect(noProof.status).toBe(400); // delivery always needs a location fix or the customer code

    const delivered = await request(app)
      .post('/driver/assignments/assignment-1/deliver')
      .set('Authorization', 'Bearer token')
      .send({ location: { latitude: 28.6, longitude: 77.2, accuracyMeters: 10 } });
    expect(delivered.status).toBe(200);
    expect(delivered.body.status).toBe('delivered');
  });

  it('rejects an assigned assignment', async () => {
    const ctx = buildDriverContext('uid-1', 'driver-1', { 'assignment-1': baseAssignment() });
    const response = await request(buildApp(ctx)).post('/driver/assignments/assignment-1/reject').set('Authorization', 'Bearer token');
    expect(response.status).toBe(200);
    expect(response.body.status).toBe('rejected');
  });

  it('returns 409 for an invalid transition', async () => {
    const ctx = buildDriverContext('uid-1', 'driver-1', { 'assignment-1': baseAssignment() });
    const response = await request(buildApp(ctx)).post('/driver/assignments/assignment-1/pickup').set('Authorization', 'Bearer token');
    expect(response.status).toBe(409);
  });

  it('returns 404 (not leaking existence) when mutating another driver\'s assignment', async () => {
    const ctx = buildDriverContext('uid-1', 'driver-1', {
      'assignment-2': baseAssignment({ assignmentId: 'assignment-2', driverId: 'a-different-driver' }),
    });
    const response = await request(buildApp(ctx)).post('/driver/assignments/assignment-2/accept').set('Authorization', 'Bearer token');
    expect(response.status).toBe(404);
  });

  it('returns 404 for a nonexistent assignment', async () => {
    const ctx = buildDriverContext('uid-1', 'driver-1');
    const response = await request(buildApp(ctx)).post('/driver/assignments/missing/accept').set('Authorization', 'Bearer token');
    expect(response.status).toBe(404);
  });

  it('returns 403 for a suspended driver, before the mutation ever runs', async () => {
    const now = new Date();
    const identityStore = createFakeIdentityStore({
      'uid-1': { firebaseUid: 'uid-1', role: 'driver', status: 'active', driver: { driverId: 'driver-1' }, createdAt: now, updatedAt: now },
    });
    const driverStore = createFakeDriverStore({
      'driver-1': { driverId: 'driver-1', firebaseUid: 'uid-1', name: 'Ravi Kumar', status: 'suspended', createdAt: now, updatedAt: now },
    });
    const roleResolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore));
    const driverService = new DriverService(driverStore);
    const assignmentStore = createFakeAssignmentStore({ 'assignment-1': baseAssignment() });
    const assignmentService = new DeliveryAssignmentService(assignmentStore, driverService, unusedOrderProvider);

    const response = await request(
      buildApp({ verifier: verifierFor('uid-1'), roleResolver, driverService, assignmentService })
    )
      .post('/driver/assignments/assignment-1/accept')
      .set('Authorization', 'Bearer token');

    expect(response.status).toBe(403);
  });
});
