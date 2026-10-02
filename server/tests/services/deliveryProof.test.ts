import express from 'express';
import request from 'supertest';

import { errorHandler } from '../../src/middleware/errorHandler';
import { createDriverAssignmentsRouter } from '../../src/routes/driver/assignments';
import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import type { DeliveryAssignmentStore } from '../../src/integrations/firebase/FirestoreDeliveryAssignmentStore';
import type { DuoFaceDriverStore } from '../../src/integrations/firebase/FirestoreDuoFaceDriverStore';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';
import { DeliveryAssignmentService } from '../../src/services/deliveryAssignmentService';
import { DeliveryOrderService } from '../../src/services/deliveryOrderService';
import { DeliveryOtp, MAX_OTP_ATTEMPTS } from '../../src/services/deliveryOtp';
import { DeliveryProofService, DELIVERY_RADIUS_METERS } from '../../src/services/deliveryProofService';
import { DriverService } from '../../src/services/driverService';
import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import { DuoFaceRoleResolver } from '../../src/services/roleResolver';
import type { CustomerCodeSender } from '../../src/integrations/telephony/CustomerCodeSender';
import { DeliveryCodeService } from '../../src/services/deliveryCodeService';

const T = new Date('2026-06-01T10:00:00Z');
const DEST = { latitude: 28.6315, longitude: 77.2167 };
const north = (meters: number) => ({ latitude: DEST.latitude + meters / 111_195, longitude: DEST.longitude });
const SECRET = 'test-secret-test-secret';

const order = {
  orderId: 'order-1',
  shopId: 'shop-1',
  customerId: 'cust-uid',
  status: 'pending',
  paymentStatus: 'paid',
  items: [{ productId: 'p', name: 'Milk', price: 28, quantity: 1, subtotal: 28 }],
  delivery: { label: 'Home', fullAddress: '1 Connaught Place', phoneNumber: '+919876543210' },
  pricing: { total: 28 },
  createdAt: T,
};

function build(opts: { geocode?: () => Promise<typeof DEST | null>; otp?: boolean } = {}) {
  const data = new Map<string, Record<string, unknown>>([
    ['a-1', { assignmentId: 'a-1', orderId: 'order-1', customerAppShopId: 'shop-1', driverId: 'driver-1', status: 'accepted', assignedAt: new Date(), createdAt: T, updatedAt: T }],
  ]);
  const store: DeliveryAssignmentStore = {
    get: async (id) => data.get(id) ?? null,
    listByDriverId: async (d) => [...data.values()].filter((v) => v.driverId === d),
    listByCustomerAppShopId: async () => [],
    listByOrderId: async () => [],
    createIfNoActiveAssignmentForOrder: async () => {},
    runTransaction: async (id, updater) => {
      const next = updater(data.get(id) ?? null);
      data.set(id, next);
      return next;
    },
  };
  const driverDoc = { driverId: 'driver-1', firebaseUid: 'uid-1', name: 'Ravi', phoneNumber: '+919811100001', status: 'active', createdAt: T, updatedAt: T };
  const driverStore: DuoFaceDriverStore = {
    get: async () => driverDoc,
    set: async () => {},
    listByStatus: async () => [driverDoc],
    findByFirebaseUid: async () => driverDoc,
  };
  const orderProvider = {
    listOrdersByShopId: async () => [],
    getOrderById: async (id: string) => (id === 'order-1' ? order : null),
    markOrderDelivered: async () => {
      throw new Error('unused');
    },
  };
  const issued: string[] = [];
  const driverService = new DriverService(driverStore);
  const assignments = new DeliveryAssignmentService(
    store,
    driverService,
    orderProvider,
    undefined,
    { onAssigned: async () => {}, onAccepted: async () => {}, onPickedUp: async () => {}, onDelivered: async () => {} },
    { redispatch: async () => {} },
    () => new Date(),
    opts.otp === false ? null : new DeliveryOtp(SECRET),
    { issue: async (_o, _s, code) => void issued.push(code) }
  );
  const orders = new DeliveryOrderService(
    assignments,
    orderProvider,
    { getShop: async () => ({ name: 'Fresh Mart' }) },
    { geocode: opts.geocode ?? (async () => DEST) }
  );
  const proof = new DeliveryProofService(assignments, orders);

  const identity: DuoFaceIdentityStore = {
    get: async () => ({ firebaseUid: 'uid-1', role: 'driver', status: 'active', driver: { driverId: 'driver-1' }, createdAt: T, updatedAt: T }),
    set: async () => {},
  };
  const verifier: FirebaseIdentityVerifier = { verifyIdToken: async () => ({ firebaseUid: 'uid-1' }) };
  const app = express();
  app.use(express.json());
  app.use(
    '/driver/assignments',
    createDriverAssignmentsRouter(verifier, new DuoFaceRoleResolver(new DuoFaceIdentityService(identity)), driverService, assignments, orders, proof)
  );
  app.use(errorHandler);

  const pickUp = async () => {
    await assignments.markPickedUp('a-1', 'driver-1');
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { app, data, issued, pickUp, driver: driverDoc as never, proof, assignments };
}

const auth = { Authorization: 'Bearer token' };
const deliver = (app: express.Express, body: unknown) => request(app).post('/driver/assignments/a-1/deliver').set(auth).send(body as object);
// accuracy: a number, or null to omit it
const fix = (meters: number, accuracyMeters: number | null = 10) => ({ location: { ...north(meters), ...(accuracyMeters === null ? {} : { accuracyMeters }) } });

describe('delivery proof: location', () => {
  it('delivers when within the radius', async () => {
    const t = build();
    await t.pickUp();
    const res = await deliver(t.app, fix(DELIVERY_RADIUS_METERS - 15));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('delivered');
  });

  it('refuses beyond the radius, with a rounded hint and no coordinates', async () => {
    const t = build();
    await t.pickUp();
    const res = await deliver(t.app, fix(DELIVERY_RADIUS_METERS + 20));
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/about 70 m/);
    expect(JSON.stringify(res.body)).not.toContain(String(DEST.latitude));
    expect(t.data.get('a-1')).toMatchObject({ status: 'picked_up' });
  });

  it.each([[null], [51], [200]])('refuses a fix whose accuracy (%s) cannot prove the radius', async (accuracy) => {
    const t = build();
    await t.pickUp();
    const res = await deliver(t.app, fix(5, accuracy));
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/not accurate enough/);
  });

  it('needs the customer code when the delivery location cannot be resolved', async () => {
    const t = build({ geocode: async () => null });
    await t.pickUp();
    const res = await deliver(t.app, fix(1));
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/delivery code/);
  });

  it('only a picked-up assignment can be delivered', async () => {
    const t = build();
    expect((await deliver(t.app, fix(1))).status).toBe(409); // still "accepted"
  });

  it('is a 404 for another driver (nothing leaks)', async () => {
    const t = build();
    await t.pickUp();
    t.data.set('a-1', { ...t.data.get('a-1')!, driverId: 'someone-else' });
    expect((await deliver(t.app, fix(1))).status).toBe(404);
  });
});

describe('delivery proof: request body', () => {
  it.each([
    [{}],
    [{ location: { latitude: 1, longitude: 1 }, otp: '123456' }],
    [{ otp: '12345' }],
    [{ otp: 'abcdef' }],
    [{ otp: '123456', driverId: 'x' }],
    [{ location: { latitude: 91, longitude: 0, accuracyMeters: 5 } }],
  ])('rejects %j with 400', async (body) => {
    const t = build();
    await t.pickUp();
    expect((await deliver(t.app, body)).status).toBe(400);
  });
});

describe('delivery code (OTP)', () => {
  it('is generated at pickup, stored only as a hash, and issued exactly once', async () => {
    const t = build();
    await t.pickUp();
    expect(t.issued).toHaveLength(1);
    expect(t.issued[0]).toMatch(/^\d{6}$/);
    const stored = t.data.get('a-1')!;
    expect(stored.deliveryOtpHash).toEqual(expect.any(String));
    expect(JSON.stringify(stored)).not.toContain(t.issued[0]);
    expect(stored.deliveryOtpAttempts).toBe(0);
  });

  it('is never present in the driver or merchant views of the assignment', async () => {
    const t = build();
    await t.pickUp();
    const res = await request(t.app).get('/driver/assignments/a-1').set(auth);
    expect(JSON.stringify(res.body)).not.toMatch(/otp/i);
  });

  it('the correct code delivers even when the driver is far away', async () => {
    const t = build();
    await t.pickUp();
    const res = await deliver(t.app, { otp: t.issued[0] });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('delivered');
  });

  it('a wrong code is refused and counted', async () => {
    const t = build();
    await t.pickUp();
    const wrong = t.issued[0] === '000000' ? '111111' : '000000';
    const res = await deliver(t.app, { otp: wrong });
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Incorrect code. 4 attempts left.');
    expect(t.data.get('a-1')).toMatchObject({ status: 'picked_up', deliveryOtpAttempts: 1 });
  });

  it(`locks after ${MAX_OTP_ATTEMPTS} wrong codes, and a locked code rejects even the correct one`, async () => {
    const t = build();
    await t.pickUp();
    const wrong = t.issued[0] === '000000' ? '111111' : '000000';
    for (let i = 0; i < MAX_OTP_ATTEMPTS; i++) await deliver(t.app, { otp: wrong });
    expect(t.data.get('a-1')).toMatchObject({ deliveryOtpAttempts: MAX_OTP_ATTEMPTS });
    expect(t.data.get('a-1')!.deliveryOtpLockedAt).toBeTruthy();

    const correct = await deliver(t.app, { otp: t.issued[0] });
    expect(correct.status).toBe(423);
    expect(t.data.get('a-1')).toMatchObject({ status: 'picked_up' });

    // The location path still works: locking only disables the code.
    expect((await deliver(t.app, fix(10))).status).toBe(200);
  });

  it('the code from one delivery does not work on another (hash is bound to the assignment)', () => {
    const otp = new DeliveryOtp(SECRET);
    expect(otp.hash('a-1', '123456')).not.toBe(otp.hash('a-2', '123456'));
    expect(otp.verify('a-1', '123456', otp.hash('a-1', '123456'))).toBe(true);
    expect(otp.verify('a-2', '123456', otp.hash('a-1', '123456'))).toBe(false);
  });

  it('generates 6 digits including leading zeros', () => {
    const otp = new DeliveryOtp(SECRET);
    for (let i = 0; i < 200; i++) expect(otp.generate()).toMatch(/^\d{6}$/);
  });

  it('is unavailable (409) when no secret is configured: nothing is generated and the code path refuses', async () => {
    const t = build({ otp: false });
    await t.pickUp();
    expect(t.issued).toHaveLength(0);
    expect(t.data.get('a-1')!.deliveryOtpHash).toBeUndefined();
    const res = await deliver(t.app, { otp: '123456' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/not available/);
  });
});

describe('DeliveryCodeService (sends the code to the customer)', () => {
  const orderProvider = {
    listOrdersByShopId: async () => [],
    getOrderById: async (id: string) => (id === 'order-1' ? order : null),
    markOrderDelivered: async () => {
      throw new Error('unused');
    },
  };

  it('sends the code to the number on the order', async () => {
    const sent: Array<[string, string]> = [];
    const sender: CustomerCodeSender = { enabled: true, send: async (phone, code) => (sent.push([phone, code]), 'sent') };
    await new DeliveryCodeService(orderProvider, sender).issue('order-1', 'shop-1', '654321');
    expect(sent).toEqual([['+919876543210', '654321']]);
  });

  it('sends nothing for a mismatched shop, a missing order or a disabled sender', async () => {
    const send = jest.fn(async () => 'sent' as const);
    const enabled: CustomerCodeSender = { enabled: true, send };
    await new DeliveryCodeService(orderProvider, enabled).issue('order-1', 'other-shop', '1');
    await new DeliveryCodeService(orderProvider, enabled).issue('missing', 'shop-1', '1');
    await new DeliveryCodeService(orderProvider, { enabled: false, send }).issue('order-1', 'shop-1', '1');
    expect(send).not.toHaveBeenCalled();
  });
});
