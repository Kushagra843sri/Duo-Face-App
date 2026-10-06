import express from 'express';
import request from 'supertest';

import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import { errorHandler } from '../../src/middleware/errorHandler';
import { createCustomerAddressesRouter } from '../../src/routes/customer/addresses';
import { createCustomerCatalogRouter } from '../../src/routes/customer/catalog';
import { createCustomerOrdersRouter, CUSTOMER_PLACE_ORDER_RATE_LIMIT } from '../../src/routes/customer/orders';
import { CustomerAddressService } from '../../src/services/customerAddressService';
import { CustomerCatalogService } from '../../src/services/customerCatalogService';
import { CustomerOrderService } from '../../src/services/customerOrderService';
import { FakeCustomerStore, inventoryOf, NOW, seed } from '../helpers/customerFixtures';

const tokens: Record<string, string> = { 'token-A': 'cust-A', 'token-B': 'cust-B' };
const verifier: FirebaseIdentityVerifier = {
  verifyIdToken: async (token) => {
    const firebaseUid = tokens[token];
    if (!firebaseUid) throw new Error('bad token');
    return { firebaseUid };
  },
};
const asA = { Authorization: 'Bearer token-A' };
const asB = { Authorization: 'Bearer token-B' };

function build(stock = 5) {
  const store = new FakeCustomerStore();
  seed(store, stock);
  const app = express();
  app.use(express.json());
  app.use('/customer/shops', createCustomerCatalogRouter(verifier, new CustomerCatalogService(store, inventoryOf(store))));
  app.use('/customer/addresses', createCustomerAddressesRouter(verifier, new CustomerAddressService(store)));
  app.use('/customer/orders', createCustomerOrdersRouter(verifier, new CustomerOrderService(store, () => NOW)));
  app.use(errorHandler);
  return { app, store };
}

const order = (over: Record<string, unknown> = {}) => ({
  clientRequestId: 'req-00000001',
  shopId: 'shop-1',
  addressId: 'addr-1',
  paymentMethod: 'cod',
  items: [{ productId: 'p-milk', quantity: 2 }],
  ...over,
});

describe('customer routes — authentication', () => {
  it.each([
    ['get', '/customer/shops'],
    ['get', '/customer/shops/shop-1/products'],
    ['get', '/customer/addresses'],
    ['get', '/customer/orders'],
    ['post', '/customer/orders'],
    ['post', '/customer/orders/x/cancel'],
  ] as const)('401 without a token: %s %s', async (method, url) => {
    const { app } = build();
    expect((await request(app)[method](url)).status).toBe(401);
    expect((await request(app)[method](url).set({ Authorization: 'Bearer nope' })).status).toBe(401);
  });
});

describe('POST /customer/orders', () => {
  it('201 creates, then 200 with the same order for a retry', async () => {
    const { app, store } = build();
    const first = await request(app).post('/customer/orders').set(asA).send(order());
    expect(first.status).toBe(201);
    expect(first.body.order.pricing.totalPaise).toBe(5700);
    const retry = await request(app).post('/customer/orders').set(asA).send(order());
    expect(retry.status).toBe(200);
    expect(retry.body.order.orderId).toBe(first.body.order.orderId);
    expect(store.read('duo_face_inventory', 'shop-1__p-milk')!.quantity).toBe(3);
  });

  it('400 on client-supplied price, customerId, role, bad quantity, wrong payment method, empty cart', async () => {
    const { app, store } = build();
    const bad = [
      order({ items: [{ productId: 'p-milk', quantity: 1, price: 1 }] }),
      order({ customerId: 'cust-B' }),
      order({ role: 'merchant' }),
      order({ totalPaise: 1 }),
      order({ items: [{ productId: 'p-milk', quantity: 0 }] }),
      order({ items: [{ productId: 'p-milk', quantity: 1.5 }] }),
      order({ items: [] }),
      order({ paymentMethod: 'cashfree' }),
      order({ clientRequestId: 'short' }),
    ];
    for (const b of bad) expect((await request(app).post('/customer/orders').set(asA).send(b)).status).toBe(400);
    expect(store.read('duo_face_inventory', 'shop-1__p-milk')!.quantity).toBe(5);
  });

  it('409 when stock is short', async () => {
    const { app } = build(1);
    const res = await request(app).post('/customer/orders').set(asA).send(order());
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/Only 1 of Milk left/);
  });

  it('rate limits order placement per customer', async () => {
    const { app } = build(500);
    let last = 0;
    for (let i = 0; i <= CUSTOMER_PLACE_ORDER_RATE_LIMIT.max; i++) {
      last = (await request(app).post('/customer/orders').set(asA).send(order({ clientRequestId: `req-${String(i).padStart(8, '0')}` }))).status;
    }
    expect(last).toBe(429);
  });
});

describe('order ownership over HTTP', () => {
  it("B gets 404 for A's order on read and cancel; A can read, list and cancel", async () => {
    const { app } = build();
    const { body } = await request(app).post('/customer/orders').set(asA).send(order());
    const id = body.order.orderId;

    expect((await request(app).get(`/customer/orders/${id}`).set(asB)).status).toBe(404);
    expect((await request(app).post(`/customer/orders/${id}/cancel`).set(asB)).status).toBe(404);
    expect((await request(app).get('/customer/orders').set(asB)).body.orders).toEqual([]);

    expect((await request(app).get(`/customer/orders/${id}`).set(asA)).status).toBe(200);
    expect((await request(app).get('/customer/orders').set(asA)).body.orders).toHaveLength(1);
    const cancelled = await request(app).post(`/customer/orders/${id}/cancel`).set(asA);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.order.status).toBe('cancelled');
  });

  it('does not leak internal fields to the customer', async () => {
    const { app } = build();
    const { body } = await request(app).post('/customer/orders').set(asA).send(order());
    expect(Object.keys(body.order).sort()).toEqual(
      ['createdAt', 'delivery', 'items', 'orderId', 'paymentMethod', 'paymentStatus', 'pricing', 'shopId', 'shopName', 'status'].sort()
    );
  });
});

describe('catalog and addresses over HTTP', () => {
  it('lists shops and products', async () => {
    const { app } = build();
    expect((await request(app).get('/customer/shops').set(asA)).body.shops).toHaveLength(1);
    const products = await request(app).get('/customer/shops/shop-1/products').set(asA);
    expect(products.body.products.map((p: { productId: string }) => p.productId)).toEqual(['p-bread', 'p-milk']);
    expect((await request(app).get('/customer/shops/nope/products').set(asA)).status).toBe(404);
  });

  it('address create validates, update/delete are scoped to the caller', async () => {
    const { app } = build();
    expect((await request(app).post('/customer/addresses').set(asA).send({ label: 'x' })).status).toBe(400);
    expect((await request(app).post('/customer/addresses').set(asA).send({ label: 'Home', fullAddress: '1 Main Road', phoneNumber: '12' })).status).toBe(400);
    const created = await request(app)
      .post('/customer/addresses')
      .set(asA)
      .send({ label: 'Office', fullAddress: '1 Main Road, Pune', phoneNumber: '9876543210', latitude: 18.5, longitude: 73.8 });
    expect(created.status).toBe(201);
    const id = created.body.address.addressId;
    expect((await request(app).patch(`/customer/addresses/${id}`).set(asB).send({ label: 'hax' })).status).toBe(404);
    expect((await request(app).delete(`/customer/addresses/${id}`).set(asB)).status).toBe(404);
    expect((await request(app).patch(`/customer/addresses/${id}`).set(asA).send({ label: 'Work' })).body.address.label).toBe('Work');
    expect((await request(app).delete(`/customer/addresses/${id}`).set(asA)).status).toBe(204);
  });
});
