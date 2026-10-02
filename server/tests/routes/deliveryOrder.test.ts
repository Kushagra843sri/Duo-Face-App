import express from 'express';
import request from 'supertest';

import { errorHandler } from '../../src/middleware/errorHandler';
import { createDriverAssignmentsRouter } from '../../src/routes/driver/assignments';
import { createMerchantDeliveriesRouter } from '../../src/routes/merchant/deliveries';
import type { CustomerAppOrderProvider } from '../../src/integrations/customerApp/CustomerAppOrderProvider';
import type { CustomerAppShopProvider } from '../../src/integrations/customerApp/CustomerAppShopProvider';
import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import type { DeliveryAssignmentStore } from '../../src/integrations/firebase/FirestoreDeliveryAssignmentStore';
import type { DuoFaceDriverStore } from '../../src/integrations/firebase/FirestoreDuoFaceDriverStore';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';
import type { DuoFaceShopStore } from '../../src/integrations/firebase/FirestoreDuoFaceShopStore';
import { CachedDeliveryGeocoder } from '../../src/integrations/geocoding/CachedDeliveryGeocoder';
import { GeocodingError } from '../../src/integrations/geocoding/OpenCageGeocodingProvider';
import type { GeocodingProvider } from '../../src/integrations/geocoding/OpenCageGeocodingProvider';
import type { DeliveryDestinationStore } from '../../src/integrations/firebase/FirestoreDeliveryDestinationStore';
import { UnconfiguredDeliveryGeocoder } from '../../src/integrations/geocoding/DeliveryGeocoder';
import type { DeliveryGeocoder } from '../../src/integrations/geocoding/DeliveryGeocoder';
import { DeliveryAssignmentService } from '../../src/services/deliveryAssignmentService';
import { DeliveryOrderService } from '../../src/services/deliveryOrderService';
import { DriverService } from '../../src/services/driverService';
import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import { DuoFaceShopService } from '../../src/services/duoFaceShopService';
import { DuoFaceRoleResolver } from '../../src/services/roleResolver';

const now = new Date();

function assignmentStore(initial: Record<string, Record<string, unknown>>): DeliveryAssignmentStore {
  const data = new Map(Object.entries(initial));
  return {
    get: async (id) => data.get(id) ?? null,
    listByDriverId: async (d) => [...data.values()].filter((v) => v.driverId === d),
    async listByOrderId() {
      return [];
    },
    listByCustomerAppShopId: async (s) => [...data.values()].filter((v) => v.customerAppShopId === s),
    createIfNoActiveAssignmentForOrder: async () => {
      throw new Error('not used');
    },
    runTransaction: async () => {
      throw new Error('not used');
    },
  };
}

function driverStore(initial: Record<string, Record<string, unknown>>): DuoFaceDriverStore {
  const data = new Map(Object.entries(initial));
  return {
    get: async (id) => data.get(id) ?? null,
    set: async () => {},
    findByFirebaseUid: async (uid) => [...data.values()].find((v) => v.firebaseUid === uid) ?? null,
    listByStatus: async (s) => [...data.values()].filter((v) => v.status === s),
  };
}

const rawOrder = {
  orderId: 'order-1',
  shopId: 'shop-1',
  customerId: 'customer-secret-uid',
  status: 'pending',
  paymentStatus: 'paid',
  paymentId: 'pay_SECRET',
  paymentOrderId: 'order_SECRET',
  paymentMethod: 'upi',
  items: [{ productId: 'product-1', name: 'Amul Milk', price: 28, quantity: 2, subtotal: 56 }],
  delivery: { label: 'Home', fullAddress: '123 MG Road', phoneNumber: '+911234567890' },
  pricing: { total: 71 },
  createdAt: now,
};

function baseAssignment(overrides: Record<string, unknown> = {}) {
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

interface Options {
  role: 'merchant' | 'driver';
  assignments?: Record<string, Record<string, unknown>>;
  orders?: Record<string, unknown>;
  shopName?: string | null;
  geocoder?: DeliveryGeocoder;
}

function build(options: Options) {
  const uid = 'uid-1';
  const identity =
    options.role === 'merchant'
      ? { firebaseUid: uid, role: 'merchant', status: 'active', merchant: { shopId: 'duo-shop-1' }, createdAt: now, updatedAt: now }
      : { firebaseUid: uid, role: 'driver', status: 'active', driver: { driverId: 'driver-1' }, createdAt: now, updatedAt: now };
  const identityStore: DuoFaceIdentityStore = { get: async () => identity, set: async () => {} };
  const shopData = new Map<string, Record<string, unknown>>([
    [
      'duo-shop-1',
      { shopId: 'duo-shop-1', name: 'Duo Shop', status: 'active', merchantFirebaseUid: uid, customerAppShopId: 'shop-1', createdAt: now, updatedAt: now },
    ],
  ]);
  const shopStore: DuoFaceShopStore = {
    get: async (id) => shopData.get(id) ?? null,
    set: async () => {},
    findByCustomerAppShopId: async (c) => [...shopData.values()].find((v) => v.customerAppShopId === c) ?? null,
    findByMerchantFirebaseUid: async (u) => [...shopData.values()].find((v) => v.merchantFirebaseUid === u) ?? null,
  };
  const drivers = new DriverService(
    driverStore({ 'driver-1': { driverId: 'driver-1', firebaseUid: uid, name: 'Ravi', status: 'active', createdAt: now, updatedAt: now } })
  );

  const orders = options.orders ?? { 'order-1': rawOrder };
  const orderProvider: CustomerAppOrderProvider = {
    listOrdersByShopId: async () => [],
    getOrderById: jest.fn(async (id: string) => orders[id] ?? null),
    markOrderDelivered: jest.fn(async () => {
      throw new Error('Customer App writes must never be invoked');
    }),
  };
  const shopProvider: CustomerAppShopProvider = {
    getShop: async () => (options.shopName === null ? null : { id: 'shop-1', name: options.shopName ?? 'Fresh Mart' }),
  };

  const assignments = new DeliveryAssignmentService(assignmentStore(options.assignments ?? { 'assignment-1': baseAssignment() }), drivers, orderProvider);
  const deliveryOrders = new DeliveryOrderService(assignments, orderProvider, shopProvider, options.geocoder ?? new UnconfiguredDeliveryGeocoder());
  const verifier: FirebaseIdentityVerifier = { verifyIdToken: async () => ({ firebaseUid: uid }) };
  const roleResolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore));

  const app = express();
  app.use(express.json());
  app.use('/driver/assignments', createDriverAssignmentsRouter(verifier, roleResolver, drivers, assignments, deliveryOrders));
  app.use(
    '/merchant/deliveries',
    createMerchantDeliveriesRouter(verifier, roleResolver, new DuoFaceShopService(shopStore), assignments, deliveryOrders)
  );
  app.use(errorHandler);
  return { app, orderProvider };
}

const auth = { Authorization: 'Bearer token' };
const DRIVER_URL = '/driver/assignments/assignment-1/order';
const MERCHANT_URL = '/merchant/deliveries/assignment-1/order';

describe('GET /driver/assignments/:id/order', () => {
  it('returns 401 unauthenticated', async () => {
    const { app } = build({ role: 'driver' });
    expect((await request(app).get(DRIVER_URL)).status).toBe(401);
  });

  it('returns 403 for a merchant identity', async () => {
    const { app } = build({ role: 'merchant' });
    expect((await request(app).get(DRIVER_URL).set(auth)).status).toBe(403);
  });

  it("returns the safe delivery DTO for the driver's own assignment — never with the phone", async () => {
    const { app } = build({ role: 'driver' });
    const response = await request(app).get(DRIVER_URL).set(auth);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      assignmentId: 'assignment-1',
      orderId: 'order-1',
      shopName: 'Fresh Mart',
      delivery: { label: 'Home', fullAddress: '123 MG Road' },
      canCallCustomer: false, // not accepted yet
      items: [{ name: 'Amul Milk', quantity: 2 }],
      itemCount: 1,
      total: 71,
    });
    expect(JSON.stringify(response.body)).not.toContain('+911234567890');
  });

  it.each([
    ['assigned', false],
    ['accepted', true],
    ['picked_up', true],
    ['delivered', false],
  ])('a driver never sees the customer phone; canCallCustomer when status is %s -> %s', async (status, canCall) => {
    const { app } = build({ role: 'driver', assignments: { 'assignment-1': baseAssignment({ status }) } });
    const response = await request(app).get(DRIVER_URL).set(auth);
    expect(response.status).toBe(200);
    expect(response.body.delivery.phoneNumber).toBeUndefined();
    expect(JSON.stringify(response.body)).not.toContain('+911234567890');
    expect(response.body.canCallCustomer).toBe(canCall);
  });

  it('returns 404 once the driver has rejected the assignment', async () => {
    const { app } = build({ role: 'driver', assignments: { 'assignment-1': baseAssignment({ status: 'rejected' }) } });
    expect((await request(app).get(DRIVER_URL).set(auth)).status).toBe(404);
  });

  it('never exposes payment ids, customer/firebase ids, product ids or per-item prices', async () => {
    const { app } = build({ role: 'driver' });
    const text = JSON.stringify((await request(app).get(DRIVER_URL).set(auth)).body);
    for (const secret of ['pay_SECRET', 'order_SECRET', 'customer-secret-uid', 'upi', 'paymentId', 'customerId', 'firebaseUid', 'productId', 'price', 'subtotal', 'product-1']) {
      expect(text).not.toContain(secret);
    }
  });

  it("returns 404 for another driver's assignment", async () => {
    const { app } = build({ role: 'driver', assignments: { 'assignment-1': baseAssignment({ driverId: 'someone-else' }) } });
    expect((await request(app).get(DRIVER_URL).set(auth)).status).toBe(404);
  });

  it('returns 404 for a missing assignment', async () => {
    const { app } = build({ role: 'driver', assignments: {} });
    expect((await request(app).get(DRIVER_URL).set(auth)).status).toBe(404);
  });

  it('returns 404 when the Customer App order no longer exists', async () => {
    const { app } = build({ role: 'driver', orders: {} });
    expect((await request(app).get(DRIVER_URL).set(auth)).status).toBe(404);
  });

  it('still returns the order when the shop name cannot be read', async () => {
    const { app } = build({ role: 'driver', shopName: null });
    const response = await request(app).get(DRIVER_URL).set(auth);
    expect(response.status).toBe(200);
    expect(response.body.shopName).toBeUndefined();
  });

  it('exposes no order-by-id route for drivers', async () => {
    const { app } = build({ role: 'driver' });
    expect((await request(app).get('/driver/orders/order-1').set(auth)).status).toBe(404);
  });
});

describe('GET /merchant/deliveries/:id/order', () => {
  it('returns 401 unauthenticated', async () => {
    const { app } = build({ role: 'merchant' });
    expect((await request(app).get(MERCHANT_URL)).status).toBe(401);
  });

  it('returns 403 for a driver identity', async () => {
    const { app } = build({ role: 'driver' });
    expect((await request(app).get(MERCHANT_URL).set(auth)).status).toBe(403);
  });

  it("returns the same safe DTO for the merchant's own shop", async () => {
    const { app } = build({ role: 'merchant' });
    const response = await request(app).get(MERCHANT_URL).set(auth);
    expect(response.status).toBe(200);
    expect(response.body.orderId).toBe('order-1');
    expect(response.body.delivery.fullAddress).toBe('123 MG Road');
    expect(response.body.delivery.phoneNumber).toBe('+911234567890'); // merchant behavior unchanged
    expect(JSON.stringify(response.body)).not.toContain('pay_SECRET');
  });

  it("returns 404 for another shop's assignment", async () => {
    const { app } = build({ role: 'merchant', assignments: { 'assignment-1': baseAssignment({ customerAppShopId: 'other-shop' }) } });
    expect((await request(app).get(MERCHANT_URL).set(auth)).status).toBe(404);
  });

  it('returns 404 for a missing assignment', async () => {
    const { app } = build({ role: 'merchant', assignments: {} });
    expect((await request(app).get(MERCHANT_URL).set(auth)).status).toBe(404);
  });

  it('returns 404 when the Customer App order no longer exists', async () => {
    const { app } = build({ role: 'merchant', orders: {} });
    expect((await request(app).get(MERCHANT_URL).set(auth)).status).toBe(404);
  });
});

describe('consistency checks', () => {
  it.each([
    ['orderId mismatch', { 'order-1': { ...rawOrder, orderId: 'order-other' } }],
    ['shopId mismatch', { 'order-1': { ...rawOrder, shopId: 'different-shop' } }],
  ])('returns 500 and exposes nothing on %s', async (_name, orders) => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { app } = build({ role: 'driver', orders });
    const response = await request(app).get(DRIVER_URL).set(auth);
    const logged = JSON.stringify(error.mock.calls);
    error.mockRestore();

    expect(response.status).toBe(500);
    expect(JSON.stringify(response.body)).not.toContain('123 MG Road');
    expect(logged).not.toContain('123 MG Road');
  });
});

describe('Customer App read-only boundary', () => {
  it('reads the order but never invokes markOrderDelivered', async () => {
    const driver = build({ role: 'driver' });
    const merchant = build({ role: 'merchant' });
    await request(driver.app).get(DRIVER_URL).set(auth);
    await request(merchant.app).get(MERCHANT_URL).set(auth);

    expect(driver.orderProvider.getOrderById).toHaveBeenCalledWith('order-1');
    expect(driver.orderProvider.markOrderDelivered).not.toHaveBeenCalled();
    expect(merchant.orderProvider.markOrderDelivered).not.toHaveBeenCalled();
  });
});

describe('driver assignment timestamp serialization', () => {
  it('returns ISO strings even when stored timestamps are Firestore Timestamp-like', async () => {
    const ts = { toDate: () => now };
    const { app } = build({ role: 'driver', assignments: { 'assignment-1': baseAssignment({ assignedAt: ts, createdAt: ts, updatedAt: ts }) } });
    const response = await request(app).get('/driver/assignments/assignment-1').set(auth);
    expect(response.status).toBe(200);
    expect(response.body.assignedAt).toBe(now.toISOString());
  });
});

describe('destination coordinates (geocoder boundary)', () => {
  const geocoder = (result: unknown): DeliveryGeocoder & { geocode: jest.Mock } => ({
    geocode: jest.fn(async () => result as never),
  });

  it('has no destination by default (no provider configured) — nothing is invented', async () => {
    const { app } = build({ role: 'driver' });
    const response = await request(app).get(DRIVER_URL).set(auth);
    expect(response.body.destination).toBeUndefined();
  });

  it('includes a destination for the owning driver when the geocoder resolves the address', async () => {
    const g = geocoder({ latitude: 28.6, longitude: 77.2 });
    const { app } = build({ role: 'driver', geocoder: g });
    const response = await request(app).get(DRIVER_URL).set(auth);
    expect(response.body.destination).toEqual({ latitude: 28.6, longitude: 77.2 });
    expect(g.geocode).toHaveBeenCalledWith('123 MG Road');
  });

  it('never geocodes or returns a destination for merchants', async () => {
    const g = geocoder({ latitude: 28.6, longitude: 77.2 });
    const { app } = build({ role: 'merchant', geocoder: g });
    const response = await request(app).get(MERCHANT_URL).set(auth);
    expect(response.status).toBe(200);
    expect(response.body.destination).toBeUndefined();
    expect(g.geocode).not.toHaveBeenCalled();
  });

  it('never geocodes for a rejected assignment (404) or another driver', async () => {
    const g = geocoder({ latitude: 28.6, longitude: 77.2 });
    const rejected = build({ role: 'driver', geocoder: g, assignments: { 'assignment-1': baseAssignment({ status: 'rejected' }) } });
    const other = build({ role: 'driver', geocoder: g, assignments: { 'assignment-1': baseAssignment({ driverId: 'x' }) } });
    expect((await request(rejected.app).get(DRIVER_URL).set(auth)).status).toBe(404);
    expect((await request(other.app).get(DRIVER_URL).set(auth)).status).toBe(404);
    expect(g.geocode).not.toHaveBeenCalled();
  });

  it.each([
    ['null result', null],
    ['out-of-range latitude', { latitude: 91, longitude: 0 }],
    ['NaN longitude', { latitude: 0, longitude: NaN }],
  ])('omits destination for %s', async (_name, result) => {
    const { app } = build({ role: 'driver', geocoder: geocoder(result) });
    const response = await request(app).get(DRIVER_URL).set(auth);
    expect(response.status).toBe(200);
    expect(response.body.destination).toBeUndefined();
  });

  it('still returns the order (without destination) when the geocoder throws', async () => {
    const g: DeliveryGeocoder = {
      geocode: async () => {
        throw new Error('provider down');
      },
    };
    const { app } = build({ role: 'driver', geocoder: g });
    const response = await request(app).get(DRIVER_URL).set(auth);
    expect(response.status).toBe(200);
    expect(response.body.destination).toBeUndefined();
  });
});

describe('driver delivery order with the real cached geocoder (fake provider/store)', () => {
  function realGeocoder(behavior: () => Promise<{ latitude: number; longitude: number; precision: number }>) {
    const data = new Map<string, Record<string, unknown>>();
    const store: DeliveryDestinationStore = {
      get: async (id) => data.get(id) ?? null,
      createIfAbsent: async (id, value) => (data.has(id) ? false : (data.set(id, value), true)),
      replace: async (id, value) => void data.set(id, value),
    };
    const provider: GeocodingProvider & { calls: number } = {
      name: 'fake',
      calls: 0,
      async geocode() {
        provider.calls++;
        return behavior();
      },
    };
    return { geocoder: new CachedDeliveryGeocoder(store, provider), provider, data };
  }

  it('populates destination on success, then serves the next request from the cache', async () => {
    const { geocoder, provider, data } = realGeocoder(async () => ({ latitude: 28.6, longitude: 77.2, precision: 9 }));
    const { app } = build({ role: 'driver', geocoder });

    const first = await request(app).get(DRIVER_URL).set(auth);
    const second = await request(app).get(DRIVER_URL).set(auth);

    expect(first.body.destination).toEqual({ latitude: 28.6, longitude: 77.2 });
    expect(second.body.destination).toEqual({ latitude: 28.6, longitude: 77.2 });
    expect(provider.calls).toBe(1);
    expect(data.size).toBe(1);
  });

  it('cached document holds no customer, phone, payment, driver or assignment data', async () => {
    const { geocoder, data } = realGeocoder(async () => ({ latitude: 28.6, longitude: 77.2, precision: 9 }));
    await request(build({ role: 'driver', geocoder }).app).get(DRIVER_URL).set(auth);
    const text = JSON.stringify([...data.values()]);
    for (const banned of ['+911234567890', 'customer-secret-uid', 'pay_SECRET', 'driver-1', 'assignment-1', 'uid-1']) {
      expect(text).not.toContain(banned);
    }
  });

  it('a geocoding failure still returns the delivery info with no destination (200)', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { geocoder } = realGeocoder(async () => {
      throw new GeocodingError('timeout');
    });
    const response = await request(build({ role: 'driver', geocoder }).app).get(DRIVER_URL).set(auth);
    warn.mockRestore();

    expect(response.status).toBe(200);
    expect(response.body.delivery.fullAddress).toBe('123 MG Road');
    expect(response.body.orderId).toBe('order-1');
    expect(response.body.destination).toBeUndefined();
  });

  it('never calls the provider for merchants, rejected assignments, other drivers or unauthenticated callers', async () => {
    const shared = realGeocoder(async () => ({ latitude: 1, longitude: 2, precision: 9 }));
    await request(build({ role: 'merchant', geocoder: shared.geocoder }).app).get(MERCHANT_URL).set(auth);
    await request(build({ role: 'merchant', geocoder: shared.geocoder }).app).get(DRIVER_URL).set(auth); // wrong role
    await request(build({ role: 'driver', geocoder: shared.geocoder }).app).get(DRIVER_URL); // no token
    await request(
      build({ role: 'driver', geocoder: shared.geocoder, assignments: { 'assignment-1': baseAssignment({ status: 'rejected' }) } }).app
    )
      .get(DRIVER_URL)
      .set(auth);
    await request(
      build({ role: 'driver', geocoder: shared.geocoder, assignments: { 'assignment-1': baseAssignment({ driverId: 'other' }) } }).app
    )
      .get(DRIVER_URL)
      .set(auth);

    expect(shared.provider.calls).toBe(0);
    expect(shared.data.size).toBe(0);
  });

  it('merchant DTOs never carry destination coordinates', async () => {
    const shared = realGeocoder(async () => ({ latitude: 1, longitude: 2, precision: 9 }));
    const response = await request(build({ role: 'merchant', geocoder: shared.geocoder }).app).get(MERCHANT_URL).set(auth);
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain('destination');
  });
});
