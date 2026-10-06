import './helpers/env';

import { installRuntime } from '../../src/runtime';
import { resetDb, UIDS } from './helpers/harness';
import { api, inboxTypes, placeOrder, settle, setupMarket } from './helpers/scenario';
import type { Market } from './helpers/scenario';

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
  return { createLiveDriverLocationStore: () => new InMemoryLiveDriverLocationStore(300_000) };
});

/** What happens when things do NOT go to plan, across the customer app and the shop app. */
let market: Market;
// Each test gets its own customers: the order rate limit (10 a minute per customer) is real and shared across tests otherwise.
let C = '';
let C2 = '';
let M = '';
let seq = 0;
const stock = async () => (await api.get(M, '/merchant/inventory')).body[0].quantity as number;

beforeAll(() => installRuntime());
beforeEach(async () => {
  resetDb();
  seq += 1;
  C = `uid-customer-a${seq}`;
  C2 = `uid-customer-b${seq}`;
  M = `uid-merchant-a${seq}`;
  market = await setupMarket({ stock: 3, customerUid: C, merchantUid: M });
});

describe('a customer cancels', () => {
  it('while the shop has not accepted: the order is cancelled, stock comes back and the shop is told', async () => {
    const order = (await placeOrder(C, market, 2)).body.order;
    expect(await stock()).toBe(1);

    const cancelled = await api.post(C, `/customer/orders/${order.orderId}/cancel`);
    expect(cancelled.body.order.status).toBe('cancelled');
    expect(await stock()).toBe(3);
    expect((await api.get(M, `/merchant/orders/${order.orderId}`)).body.status).toBe('cancelled');
    await settle(async () => (await inboxTypes(M)).includes('order_cancelled_by_customer'), 'shop told about the cancel');
  });

  it('but not once the shop has accepted it', async () => {
    const order = (await placeOrder(C, market)).body.order;
    await api.patch(M, `/merchant/orders/${order.orderId}/status`, { status: 'confirmed' });
    expect((await api.post(C, `/customer/orders/${order.orderId}/cancel`)).status).toBe(409);
    expect((await api.get(C, `/customer/orders/${order.orderId}`)).body.order.status).toBe('confirmed');
  });
});

describe('the shop declines', () => {
  it('rejecting puts the stock back and tells the customer; the order cannot be revived', async () => {
    const order = (await placeOrder(C, market, 3)).body.order;
    expect(await stock()).toBe(0);

    expect((await api.patch(M, `/merchant/orders/${order.orderId}/status`, { status: 'rejected' })).status).toBe(200);
    expect(await stock()).toBe(3);
    expect((await api.get(C, `/customer/orders/${order.orderId}`)).body.order.status).toBe('rejected');
    await settle(async () => (await inboxTypes(C)).includes('order_rejected'), 'customer told the order was declined');
    expect((await api.patch(M, `/merchant/orders/${order.orderId}/status`, { status: 'confirmed' })).status).toBe(409);
  });

  it('the shop cannot skip steps (pending cannot go straight to ready)', async () => {
    const order = (await placeOrder(C, market)).body.order;
    expect((await api.patch(M, `/merchant/orders/${order.orderId}/status`, { status: 'ready_for_pickup' })).status).toBe(409);
  });
});

describe('stock and the closed sign', () => {
  it('two customers racing for the last unit: exactly one gets it, nobody gets a negative stock', async () => {
    await api.patch(M, `/merchant/inventory/${market.productId}/quantity`, { quantity: 1 });
    const second = await api.post(C2, '/customer/addresses', { label: 'Home', fullAddress: '7 Lake Road, Delhi', phoneNumber: '9876500000' });
    const market2 = { ...market, addressId: second.body.address.addressId };

    const [a, b] = await Promise.all([placeOrder(C, market), placeOrder(C2, market2)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await stock()).toBe(0);
    expect((await api.get(M, '/merchant/orders')).body).toHaveLength(1);
  });

  it('closing the shop stops new orders at once; reopening allows them again', async () => {
    await api.put(M, '/merchant/shop/open', { isOpen: false });
    expect((await api.get(C, '/customer/shops')).body.shops[0].isOpen).toBe(false);
    expect((await placeOrder(C, market)).status).toBe(409);
    await api.put(M, '/merchant/shop/open', { isOpen: true });
    expect((await placeOrder(C, market)).status).toBe(201);
  });

  it('a hidden product disappears from the customer app and cannot be ordered', async () => {
    await api.patch(M, `/merchant/products/${market.productId}`, { isAvailable: false });
    expect((await api.get(C, `/customer/shops/${market.shopId}/products`)).body.products).toEqual([]);
    expect((await placeOrder(C, market)).status).toBe(404);
  });

  it('a price change applies to new orders only; the order already placed keeps its price', async () => {
    const before = (await placeOrder(C, market)).body.order;
    await api.patch(M, `/merchant/products/${market.productId}`, { pricePaise: 4000 });
    const after = (await placeOrder(C, market)).body.order;
    expect(before.pricing.totalPaise).toBe(2850);
    expect(after.pricing.totalPaise).toBe(4000);
    expect((await api.get(C, `/customer/orders/${before.orderId}`)).body.order.pricing.totalPaise).toBe(2850);
  });
});

describe('privacy between people', () => {
  it("a customer cannot read another customer's order, tracking or delivery code", async () => {
    const order = (await placeOrder(C, market)).body.order;
    for (const path of [`/customer/orders/${order.orderId}`, `/customer/orders/${order.orderId}/tracking`, `/customer/orders/${order.orderId}/delivery-code`]) {
      expect((await api.get(C2, path)).status).toBe(404);
    }
    expect((await api.post(C2, `/customer/orders/${order.orderId}/cancel`)).status).toBe(404);
    expect((await api.get(C2, '/customer/orders')).body.orders).toEqual([]);
  });

  it("a shop never sees, or changes, another shop's orders", async () => {
    const order = (await placeOrder(C, market)).body.order;
    expect((await api.post(`${M}-other`, '/auth/register', { intent: 'merchant', shopName: 'Other Shop' })).status).toBe(201);
    expect((await api.get(`${M}-other`, '/merchant/orders')).body).toEqual([]);
    expect((await api.get(`${M}-other`, `/merchant/orders/${order.orderId}`)).status).toBe(404);
    expect((await api.patch(`${M}-other`, `/merchant/orders/${order.orderId}/status`, { status: 'confirmed' })).status).toBe(404);
    expect((await api.post(`${M}-other`, '/merchant/deliveries', { orderId: order.orderId })).status).not.toBe(201);
  });

  it('a driver sees only their own assignments, and a customer, shop or driver cannot use admin screens', async () => {
    expect((await api.post(UIDS.driver, '/auth/register', { intent: 'driver', name: 'Ravi' })).status).toBe(201);
    expect((await api.get(UIDS.driver, '/driver/assignments')).body).toEqual([]);
    for (const uid of [C, M, UIDS.driver]) {
      expect((await api.get(uid, '/admin/refunds')).status).toBe(403);
      expect((await api.get(uid, '/admin/verifications')).status).toBe(403);
    }
    expect((await api.get(UIDS.admin, '/admin/verifications')).status).toBe(200);
  });
});
