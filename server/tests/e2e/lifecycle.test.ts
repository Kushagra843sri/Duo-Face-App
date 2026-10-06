import './helpers/env';

import request from 'supertest';

import { app } from '../../src/app';
import { installRuntime } from '../../src/runtime';
import { as, resetDb, UIDS } from './helpers/harness';

jest.mock('firebase-admin/firestore', () => require('./helpers/firestoreMock'));
jest.mock('firebase-admin/app', () => ({ initializeApp: () => ({}), cert: () => ({}), applicationDefault: () => ({}), getApps: () => [] }));
jest.mock('firebase-admin/auth', () => ({
  getAuth: () => ({
    verifyIdToken: async (token: string) => {
      if (!token.startsWith('tok-')) throw new Error('invalid token');
      return { uid: token.slice(4) };
    },
  }),
}));
jest.mock('../../src/integrations/redis/createLiveDriverLocationStore', () => {
  const { InMemoryLiveDriverLocationStore } = require('../../src/integrations/redis/LiveDriverLocationStore');
  const store = new InMemoryLiveDriverLocationStore(300_000);
  return { createLiveDriverLocationStore: () => store };
});

/**
 * One order from a brand-new shop to a delivered parcel, entirely through the
 * real HTTP API with each person's own token, exactly the way the apps do it:
 * nothing is seeded behind the API's back. Steps run in order and share state.
 */
const api = {
  get: (uid: string, path: string) => request(app).get(path).set(as(uid)),
  post: (uid: string, path: string, body?: object) => request(app).post(path).set(as(uid)).send(body ?? {}),
  patch: (uid: string, path: string, body: object) => request(app).patch(path).set(as(uid)).send(body),
  put: (uid: string, path: string, body: object) => request(app).put(path).set(as(uid)).send(body),
};

/** Lets background work (notifications, delivery code, order sync) finish; they are fire-and-forget by design. */
const settle = async (check: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for: ${what}`);
};

const HOME = { latitude: 28.6139, longitude: 77.209 }; // the customer's address
const SHOP = { latitude: 28.6, longitude: 77.18 };
const near = (meters: number) => ({ latitude: HOME.latitude + meters / 111_320, longitude: HOME.longitude });

const inbox = async (uid: string) => (await api.get(uid, '/notifications')).body as { notifications: { type: string; orderId: string | null }[]; unread: number };
const inboxTypes = async (uid: string) => (await inbox(uid)).notifications.map((n) => n.type);

const ctx = { shopId: '', customerAppShopId: '', productId: '', addressId: '', orderId: '', assignmentId: '', code: '' };

beforeAll(() => {
  installRuntime();
  resetDb();
});

describe('onboarding: people register and the shop gets ready to sell', () => {
  it('a merchant and a driver register through the app', async () => {
    expect((await api.post(UIDS.merchant, '/auth/register', { intent: 'merchant', shopName: 'Fresh Mart' })).status).toBe(201);
    expect((await api.post(UIDS.driver, '/auth/register', { intent: 'driver', name: 'Ravi Kumar' })).status).toBe(201);
    const me = await api.get(UIDS.merchant, '/merchant/me');
    expect(me.status).toBe(200);
    ctx.shopId = me.body.shopId;
    ctx.customerAppShopId = ctx.shopId; // one id for the shop on both sides
  });

  it('the new shop is listed for customers but CLOSED until the owner opens it', async () => {
    expect((await api.get(UIDS.merchant, '/merchant/shop')).body).toMatchObject({ shopId: ctx.shopId, name: 'Fresh Mart', listed: true, isOpen: false });
    const shops = await api.get(UIDS.customer, '/customer/shops');
    expect(shops.body.shops).toMatchObject([{ shopId: ctx.shopId, name: 'Fresh Mart', isOpen: false }]);
  });

  it('the owner fills in the shop profile: customers see the same name and address, and the pickup point is set', async () => {
    const res = await api.patch(UIDS.merchant, '/merchant/profile', {
      personal: { shopName: 'Fresh Mart Deluxe', ownerName: 'Anil Sharma', contactPhone: '+919822200001', address: { line1: '5 Market Road', city: 'Delhi', pincode: '110016' } },
      pickupLocation: SHOP,
    });
    expect(res.status).toBe(200);
    await settle(async () => (await api.get(UIDS.customer, '/customer/shops')).body.shops[0].name === 'Fresh Mart Deluxe', 'listing name sync');
    expect((await api.get(UIDS.customer, '/customer/shops')).body.shops[0].address).toBe('5 Market Road, Delhi 110016');
  });

  it('the owner adds a product with its starting stock, and sees it in the product list', async () => {
    const created = await api.post(UIDS.merchant, '/merchant/products', { name: 'Toned Milk 500 ml', description: 'Fresh pouch', pricePaise: 2850, quantity: 10 });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Toned Milk 500 ml', description: 'Fresh pouch', price: 28.5, isActive: true, inventory: { quantity: 10, status: 'active' } });
    ctx.productId = created.body.productId;
    expect((await api.get(UIDS.merchant, '/merchant/products')).body).toMatchObject([{ productId: ctx.productId, price: 28.5, inventory: { quantity: 10 } }]);
  });

  it('a closed shop cannot be ordered from, even with a product in stock', async () => {
    const address = await api.post(UIDS.customer, '/customer/addresses', { label: 'Home', fullAddress: '12 Park Street, Delhi 110001', phoneNumber: '9876543210', ...HOME });
    ctx.addressId = address.body.address.addressId;
    const order = await api.post(UIDS.customer, '/customer/orders', {
      clientRequestId: 'e2e-closed-0001',
      shopId: ctx.customerAppShopId,
      addressId: ctx.addressId,
      paymentMethod: 'cod',
      items: [{ productId: ctx.productId, quantity: 1 }],
    });
    expect(order.status).toBe(409);
    expect(order.body.message).toMatch(/closed/i);
  });

  it('the owner can hide a product and show it again; another shop cannot touch it; bad prices are refused', async () => {
    expect((await api.patch(UIDS.merchant, `/merchant/products/${ctx.productId}`, { isAvailable: false })).body.isActive).toBe(false);
    expect((await api.get(UIDS.merchant, '/merchant/products')).body[0]).toMatchObject({ isActive: false });

    expect((await api.post('uid-merchant-2', '/auth/register', { intent: 'merchant', shopName: 'Other Shop' })).status).toBe(201);
    expect((await api.patch('uid-merchant-2', `/merchant/products/${ctx.productId}`, { name: 'Hijacked' })).status).toBe(404);
    expect((await api.patch(UIDS.merchant, `/merchant/products/${ctx.productId}`, { pricePaise: 50 })).status).toBe(400); // below Rs 1
    expect((await api.patch(UIDS.merchant, `/merchant/products/${ctx.productId}`, { isAvailable: true })).body.isActive).toBe(true);
  });

  it('the owner opens the shop, and customers can now see the product', async () => {
    expect((await api.put(UIDS.merchant, '/merchant/shop/open', { isOpen: true })).body).toMatchObject({ listed: true, isOpen: true });
    const products = await api.get(UIDS.customer, `/customer/shops/${ctx.customerAppShopId}/products`);
    expect(products.body.products).toMatchObject([{ productId: ctx.productId, name: 'Toned Milk 500 ml', description: 'Fresh pouch', pricePaise: 2850, available: 10 }]);
  });

  it('the driver goes on duty and shares a location (driver dashboard does this)', async () => {
    expect((await api.put(UIDS.driver, '/driver/duty', { onDuty: true })).status).toBe(200);
    expect((await api.post(UIDS.driver, '/driver/location', { latitude: 28.601, longitude: 77.181 })).status).toBe(200);
  });
});

describe('a customer places an order and it reaches the shop', () => {
  it('the customer places a cash order', async () => {
    const order = await api.post(UIDS.customer, '/customer/orders', {
      clientRequestId: 'e2e-request-0001',
      shopId: ctx.customerAppShopId,
      addressId: ctx.addressId,
      paymentMethod: 'cod',
      items: [{ productId: ctx.productId, quantity: 2 }],
    });
    expect(order.status).toBe(201);
    expect(order.body.order).toMatchObject({ status: 'pending', paymentMethod: 'cod', pricing: { totalPaise: 5700 } });
    ctx.orderId = order.body.order.orderId;
    expect((await api.get(UIDS.merchant, '/merchant/inventory')).body).toMatchObject([{ productId: ctx.productId, quantity: 8 }]);
  });

  it("the shop sees the order in its list with the customer's details", async () => {
    const list = await api.get(UIDS.merchant, '/merchant/orders');
    expect(list.status).toBe(200);
    expect(list.body).toMatchObject([{ orderId: ctx.orderId, status: 'pending', itemCount: 1, total: 57 }]);
    const detail = await api.get(UIDS.merchant, `/merchant/orders/${ctx.orderId}`);
    expect(detail.body).toMatchObject({
      orderId: ctx.orderId,
      items: [{ productId: ctx.productId, name: 'Toned Milk 500 ml', quantity: 2, price: 28.5, subtotal: 57 }],
      delivery: { label: 'Home', fullAddress: '12 Park Street, Delhi 110001' },
    });
  });

  it('the shop is notified of the new order', async () => {
    await settle(async () => (await inboxTypes(UIDS.merchant)).includes('new_order'), 'merchant new_order notification');
    const n = (await inbox(UIDS.merchant)).notifications.find((x) => x.type === 'new_order')!;
    expect(n.orderId).toBe(ctx.orderId);
  });
});

describe('the shop works the order', () => {
  it.each(['confirmed', 'preparing', 'ready_for_pickup'] as const)('the shop marks it %s and the customer sees it', async (status) => {
    const res = await api.patch(UIDS.merchant, `/merchant/orders/${ctx.orderId}/status`, { status });
    expect(res.status).toBe(200);
    expect((await api.get(UIDS.customer, `/customer/orders/${ctx.orderId}`)).body.order.status).toBe(status);
  });

  it('the customer is told the shop confirmed', async () => {
    await settle(async () => (await inboxTypes(UIDS.customer)).includes('order_confirmed'), 'customer order_confirmed notification');
  });
});

describe('a delivery partner is assigned and picks the order up', () => {
  it('the shop requests a driver and the nearest available one is offered the job', async () => {
    const res = await api.post(UIDS.merchant, '/merchant/deliveries', { orderId: ctx.orderId });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ orderId: ctx.orderId, status: 'assigned' });
    ctx.assignmentId = res.body.assignmentId;
  });

  it('the driver sees the offer in their list and is notified', async () => {
    const list = await api.get(UIDS.driver, '/driver/assignments');
    expect(list.body).toMatchObject([{ assignmentId: ctx.assignmentId, status: 'assigned' }]);
    await settle(async () => (await inboxTypes(UIDS.driver)).includes('new_delivery_offer'), 'driver new_delivery_offer notification');
  });

  it('the driver can read the order they are asked to deliver (without the customer phone)', async () => {
    const order = await api.get(UIDS.driver, `/driver/assignments/${ctx.assignmentId}/order`);
    expect(order.status).toBe(200);
    expect(JSON.stringify(order.body)).not.toContain('9876543210');
    expect(JSON.stringify(order.body)).toContain('12 Park Street');
  });

  it('the driver accepts; the shop and the customer are told', async () => {
    expect((await api.post(UIDS.driver, `/driver/assignments/${ctx.assignmentId}/accept`)).status).toBe(200);
    await settle(async () => (await inboxTypes(UIDS.merchant)).includes('shop_driver_accepted'), 'merchant shop_driver_accepted notification');
  });

  it('the driver picks the order up and it becomes "out for delivery" for the customer', async () => {
    expect((await api.post(UIDS.driver, `/driver/assignments/${ctx.assignmentId}/pickup`)).status).toBe(200);
    await settle(async () => (await api.get(UIDS.customer, `/customer/orders/${ctx.orderId}`)).body.order.status === 'out_for_delivery', 'order out_for_delivery');
  });

  it('the customer can now read the delivery code to hand over', async () => {
    let code = '';
    await settle(async () => {
      const res = await api.get(UIDS.customer, `/customer/orders/${ctx.orderId}/delivery-code`);
      code = res.status === 200 ? res.body.code : '';
      return /^\d{6}$/.test(code);
    }, 'delivery code');
    ctx.code = code;
  });
});

describe('the customer follows the delivery', () => {
  // The driver app sends a ping every ~10 s; "nearby" looks at most once per 20 s per order, so a single
  // close ping is enough to exercise both the map and the "nearby" alert.
  it('the driver position shows on the customer map', async () => {
    const ping = await api.post(UIDS.driver, '/driver/tracking/location', { assignmentId: ctx.assignmentId, ...near(150), accuracyMeters: 10 });
    expect(ping.status).toBe(200);
    const tracking = (await api.get(UIDS.customer, `/customer/orders/${ctx.orderId}/tracking`)).body.tracking;
    expect(tracking).toMatchObject({ available: true, status: 'picked_up' });
    expect(tracking.location).toMatchObject({ fresh: true });
  });

  it('the delivery address also shows on the map, from the GPS point the customer saved (no paid geocoder needed)', async () => {
    const tracking = (await api.get(UIDS.customer, `/customer/orders/${ctx.orderId}/tracking`)).body.tracking;
    expect(tracking.destination).toMatchObject({ latitude: HOME.latitude, longitude: HOME.longitude });
  });

  it("the driver's own order screen has the destination to navigate to", async () => {
    const order = await api.get(UIDS.driver, `/driver/assignments/${ctx.assignmentId}/order`);
    expect(order.body.destination).toMatchObject({ latitude: HOME.latitude, longitude: HOME.longitude });
  });

  it('the customer is told when the driver gets close', async () => {
    await settle(async () => (await inboxTypes(UIDS.customer)).includes('driver_nearby'), 'customer driver_nearby notification');
  });
});

describe('delivery is completed with the customer code', () => {
  it('a wrong code is refused and the right one completes the delivery', async () => {
    const wrong = ctx.code === '000000' ? '111111' : '000000';
    expect((await api.post(UIDS.driver, `/driver/assignments/${ctx.assignmentId}/deliver`, { otp: wrong })).status).toBe(409);
    const done = await api.post(UIDS.driver, `/driver/assignments/${ctx.assignmentId}/deliver`, { otp: ctx.code });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('delivered');
  });

  it('the order shows as delivered to the customer and the shop', async () => {
    await settle(async () => (await api.get(UIDS.customer, `/customer/orders/${ctx.orderId}`)).body.order.status === 'delivered', 'order delivered');
    expect((await api.get(UIDS.merchant, `/merchant/orders/${ctx.orderId}`)).body.status).toBe('delivered');
  });

  it("the customer's inbox tells the whole story, in the app, not only as a push", async () => {
    await settle(async () => (await inboxTypes(UIDS.customer)).includes('delivery_completed'), 'customer delivery_completed notification');
    const types = await inboxTypes(UIDS.customer);
    for (const expected of ['order_confirmed', 'delivery_assigned', 'delivery_accepted', 'driver_picked_up', 'driver_nearby', 'delivery_completed']) {
      expect(types).toContain(expected);
    }
  });

  it('the shop and the driver can see the finished delivery in their lists', async () => {
    expect((await api.get(UIDS.merchant, '/merchant/deliveries')).body).toMatchObject([{ assignmentId: ctx.assignmentId, status: 'delivered' }]);
    expect((await api.get(UIDS.driver, '/driver/assignments')).body).toMatchObject([{ assignmentId: ctx.assignmentId, status: 'delivered' }]);
  });
});
