import express from 'express';
import request from 'supertest';

import { errorHandler } from '../../src/middleware/errorHandler';
import { createDriverDutyRouter } from '../../src/routes/driver/duty';
import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import type { DeliveryAssignmentStore } from '../../src/integrations/firebase/FirestoreDeliveryAssignmentStore';
import type { DuoFaceDriverStore } from '../../src/integrations/firebase/FirestoreDuoFaceDriverStore';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';
import { DeliveryAssignmentService } from '../../src/services/deliveryAssignmentService';
import { DriverDutyService } from '../../src/services/driverDutyService';
import { DriverService } from '../../src/services/driverService';
import type { DriverTrackingService } from '../../src/services/driverTrackingService';
import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import { DuoFaceRoleResolver } from '../../src/services/roleResolver';

const T = new Date('2026-06-01T10:00:00Z');

function driverStore(initial: Record<string, Record<string, unknown>>): DuoFaceDriverStore & { data: Map<string, Record<string, unknown>> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get: async (id) => data.get(id) ?? null,
    set: async (id, v) => {
      data.set(id, v);
    },
    listByStatus: async (st) => [...data.values()].filter((v) => v.status === st),
    findByFirebaseUid: async (uid) => [...data.values()].find((v) => v.firebaseUid === uid) ?? null,
  };
}

function assignmentStore(initial: Record<string, Record<string, unknown>> = {}): DeliveryAssignmentStore {
  const data = new Map(Object.entries(initial));
  return {
    get: async (id) => data.get(id) ?? null,
    listByDriverId: async (d) => [...data.values()].filter((v) => v.driverId === d),
    listByCustomerAppShopId: async () => [],
    listByOrderId: async () => [],
    createIfNoActiveAssignmentForOrder: async () => {},
    runTransaction: async (id, updater) => updater(data.get(id) ?? null),
  };
}

const assignment = (status: string, driverId = 'driver-1') => ({
  assignmentId: `a-${status}-${driverId}`,
  orderId: 'order-1',
  customerAppShopId: 'shop-1',
  driverId,
  status,
  assignedAt: new Date(), // a live offer: stale ones no longer count as active
  createdAt: T,
  updatedAt: T,
});

const driverDoc = (over: Record<string, unknown> = {}) => ({
  driverId: 'driver-1',
  firebaseUid: 'uid-1',
  name: 'Ravi',
  status: 'active',
  createdAt: T,
  updatedAt: T,
  ...over,
});

function build(opts: { drivers?: Record<string, Record<string, unknown>>; assignments?: Record<string, Record<string, unknown>>; role?: 'driver' | 'merchant' } = {}) {
  const drivers = driverStore(opts.drivers ?? { 'driver-1': driverDoc() });
  const driverService = new DriverService(drivers);
  const stopped: string[] = [];
  const tracking = { stopTracking: async (id: string) => void stopped.push(id) } as unknown as DriverTrackingService;
  const dutyService = new DriverDutyService(driverService, new DeliveryAssignmentService(assignmentStore(opts.assignments)), tracking);

  const identity: DuoFaceIdentityStore = {
    get: async () =>
      opts.role === 'merchant'
        ? { firebaseUid: 'uid-1', role: 'merchant', status: 'active', merchant: { shopId: 's' }, createdAt: T, updatedAt: T }
        : { firebaseUid: 'uid-1', role: 'driver', status: 'active', driver: { driverId: 'driver-1' }, createdAt: T, updatedAt: T },
    set: async () => {},
  };
  const verifier: FirebaseIdentityVerifier = { verifyIdToken: async () => ({ firebaseUid: 'uid-1' }) };
  const app = express();
  app.use(express.json());
  app.use('/driver/duty', createDriverDutyRouter(verifier, new DuoFaceRoleResolver(new DuoFaceIdentityService(identity)), driverService, dutyService));
  app.use(errorHandler);
  return { app, drivers, stopped, dutyService };
}

const auth = { Authorization: 'Bearer token' };

describe('DriverService.setDuty', () => {
  it('changes only the duty fields', async () => {
    const store = driverStore({ 'driver-1': driverDoc({ phoneNumber: '+911' }) });
    const service = new DriverService(store);
    const on = await service.setDuty('driver-1', true);
    expect(on).toMatchObject({ onDuty: true, name: 'Ravi', phoneNumber: '+911', status: 'active' });
    expect(on.dutyChangedAt).toBeInstanceOf(Date);
    expect((await service.setDuty('driver-1', false)).onDuty).toBe(false);
  });

  it('throws for a missing driver', async () => {
    await expect(new DriverService(driverStore({})).setDuty('nope', true)).rejects.toThrow(/no such driver/);
  });
});

describe('GET/PUT /driver/duty', () => {
  it('defaults to off duty', async () => {
    const { app } = build();
    const res = await request(app).get('/driver/duty').set(auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ onDuty: false, dutyChangedAt: null });
  });

  it('activates, then deactivates, and persists on the authenticated driver only', async () => {
    const { app, drivers, stopped } = build({ drivers: { 'driver-1': driverDoc(), 'driver-2': driverDoc({ driverId: 'driver-2', firebaseUid: 'uid-2' }) } });
    const on = await request(app).put('/driver/duty').set(auth).send({ onDuty: true });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ onDuty: true, dutyChangedAt: expect.any(String) });
    expect(drivers.data.get('driver-1')).toMatchObject({ onDuty: true });
    expect(drivers.data.get('driver-2')?.onDuty).toBeUndefined();
    expect(stopped).toEqual([]);

    const off = await request(app).put('/driver/duty').set(auth).send({ onDuty: false });
    expect(off.body.onDuty).toBe(false);
    expect(stopped).toEqual(['driver-1']); // live position dropped
  });

  it.each([
    [{ onDuty: true, driverId: 'driver-2' }],
    [{ onDuty: 'yes' }],
    [{}],
  ])('rejects an invalid body (%j) with 400', async (body) => {
    const { app } = build();
    expect((await request(app).put('/driver/duty').set(auth).send(body)).status).toBe(400);
  });

  it.each(['assigned', 'accepted', 'picked_up'])('blocks going off duty with a %s delivery (409) and stays on duty', async (status) => {
    const { app, drivers, stopped } = build({
      drivers: { 'driver-1': driverDoc({ onDuty: true }) },
      assignments: { a: assignment(status) },
    });
    const res = await request(app).put('/driver/duty').set(auth).send({ onDuty: false });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Finish or reject your current delivery first.');
    expect(drivers.data.get('driver-1')).toMatchObject({ onDuty: true });
    expect(stopped).toEqual([]);
  });

  it('allows going off duty when the only deliveries are finished or rejected, or belong to someone else', async () => {
    const { app } = build({
      drivers: { 'driver-1': driverDoc({ onDuty: true }) },
      assignments: { a: assignment('delivered'), b: assignment('rejected'), c: assignment('cancelled'), d: assignment('picked_up', 'driver-2') },
    });
    expect((await request(app).put('/driver/duty').set(auth).send({ onDuty: false })).status).toBe(200);
  });

  it('an unanswered offer past its time limit does not block going off duty (and is expired)', async () => {
    const stale = { ...assignment('assigned'), assignedAt: new Date(Date.now() - 10 * 60 * 1000) };
    const { app } = build({ drivers: { 'driver-1': driverDoc({ onDuty: true }) }, assignments: { [stale.assignmentId]: stale } });
    expect((await request(app).put('/driver/duty').set(auth).send({ onDuty: false })).status).toBe(200);
  });

  it('going ON duty is allowed even with an active delivery', async () => {
    const { app } = build({ assignments: { a: assignment('accepted') } });
    expect((await request(app).put('/driver/duty').set(auth).send({ onDuty: true })).status).toBe(200);
  });

  it('rejects a merchant principal and a suspended driver', async () => {
    const merchant = build({ role: 'merchant' });
    expect((await request(merchant.app).put('/driver/duty').set(auth).send({ onDuty: true })).status).toBe(403);
    const suspended = build({ drivers: { 'driver-1': driverDoc({ status: 'suspended' }) } });
    expect((await request(suspended.app).get('/driver/duty').set(auth)).status).toBe(403);
  });

  it('requires authentication', async () => {
    const { app } = build();
    expect((await request(app).get('/driver/duty')).status).toBe(401);
  });
});
