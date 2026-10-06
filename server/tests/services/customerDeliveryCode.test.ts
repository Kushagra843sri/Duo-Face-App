import express from 'express';
import request from 'supertest';

import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import type { DeliveryCodeStore } from '../../src/integrations/firebase/FirestoreDeliveryCodeStore';
import { errorHandler } from '../../src/middleware/errorHandler';
import { createCustomerOrdersRouter } from '../../src/routes/customer/orders';
import { CustomerDeliveryCodeService } from '../../src/services/customerDeliveryCodeService';
import { CustomerOrderService } from '../../src/services/customerOrderService';
import { DeliveryCodeService } from '../../src/services/deliveryCodeService';
import { FieldCrypto } from '../../src/services/fieldCrypto';
import { FakeCustomerStore, NOW, seed } from '../helpers/customerFixtures';

const crypto = new FieldCrypto(Buffer.alloc(32, 7));

function fakeCodeStore() {
  const docs = new Map<string, Record<string, unknown>>();
  const store: DeliveryCodeStore = {
    get: async (id) => docs.get(id) ?? null,
    set: async (id, data) => void docs.set(id, data),
  };
  return { docs, store };
}

async function setup() {
  const data = new FakeCustomerStore();
  seed(data, 5);
  const placed = await new CustomerOrderService(data, () => NOW).placeOrder('cust-A', {
    clientRequestId: 'req-00000001',
    shopId: 'shop-1',
    addressId: 'addr-1',
    paymentMethod: 'cod',
    items: [{ productId: 'p-milk', quantity: 1 }],
  });
  const { docs, store } = fakeCodeStore();
  const orderProvider = {
    getOrderById: async (id: string) => data.read('orders', id) && { ...data.read('orders', id), orderId: id },
    listOrdersByShopId: async () => [],
    markOrderDelivered: async () => {
      throw new Error('unused');
    },
  };
  const send = jest.fn().mockResolvedValue('sent');
  const issuer = new DeliveryCodeService(orderProvider as never, { enabled: true, send }, store, crypto, () => NOW);
  return { data, docs, store, issuer, send, orderId: placed.order.orderId, reader: new CustomerDeliveryCodeService(data, store, crypto) };
}

describe('delivery code for in-app display', () => {
  it('issue stores the code encrypted (never plaintext) and still sends the SMS', async () => {
    const { docs, issuer, send, orderId } = await setup();
    await issuer.issue(orderId, 'shop-1', '654321');
    const doc = docs.get(orderId)!;
    expect(JSON.stringify(doc)).not.toContain('654321');
    expect(String(doc.code)).toMatch(/^v1:/);
    expect(send).toHaveBeenCalledWith('9876543210', '654321');
  });

  it('issue stores the code even when SMS is disabled', async () => {
    const { data, docs, store, orderId } = await setup();
    const issuer = new DeliveryCodeService(
      { getOrderById: async (id: string) => ({ ...data.read('orders', id), orderId: id }), listOrdersByShopId: async () => [], markOrderDelivered: async () => { throw new Error('x'); } } as never,
      { enabled: false, send: jest.fn() },
      store,
      crypto
    );
    await issuer.issue(orderId, 'shop-1', '111222');
    expect(docs.has(orderId)).toBe(true);
  });

  it('owner reads the code only while the order is out for delivery', async () => {
    const { data, issuer, reader, orderId } = await setup();
    await issuer.issue(orderId, 'shop-1', '654321');

    await expect(reader.getCode('cust-A', orderId)).rejects.toMatchObject({ statusCode: 409 }); // still pending
    data.put('orders', orderId, { ...data.read('orders', orderId)!, status: 'out_for_delivery' });
    expect(await reader.getCode('cust-A', orderId)).toEqual({ code: '654321' });
    data.put('orders', orderId, { ...data.read('orders', orderId)!, status: 'delivered' });
    await expect(reader.getCode('cust-A', orderId)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("another customer gets 404; a tampered/foreign ciphertext is refused", async () => {
    const { data, docs, issuer, reader, orderId } = await setup();
    await issuer.issue(orderId, 'shop-1', '654321');
    data.put('orders', orderId, { ...data.read('orders', orderId)!, status: 'out_for_delivery' });
    await expect(reader.getCode('cust-B', orderId)).rejects.toMatchObject({ statusCode: 404 });

    docs.set(orderId, { ...docs.get(orderId)!, code: crypto.encrypt('999999', 'delivery-code:some-other-order') });
    await expect(reader.getCode('cust-A', orderId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('503 without an encryption key, 404 when no code was ever stored', async () => {
    const { data, store, reader, orderId } = await setup();
    data.put('orders', orderId, { ...data.read('orders', orderId)!, status: 'out_for_delivery' });
    await expect(reader.getCode('cust-A', orderId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(new CustomerDeliveryCodeService(data, store, null).getCode('cust-A', orderId)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('GET /customer/orders/:id/delivery-code over HTTP', async () => {
    const { data, issuer, reader, orderId } = await setup();
    await issuer.issue(orderId, 'shop-1', '654321');
    data.put('orders', orderId, { ...data.read('orders', orderId)!, status: 'out_for_delivery' });
    const verifier: FirebaseIdentityVerifier = {
      verifyIdToken: async (t) => {
        if (t !== 'a' && t !== 'b') throw new Error('bad');
        return { firebaseUid: t === 'a' ? 'cust-A' : 'cust-B' };
      },
    };
    const app = express();
    app.use('/customer/orders', createCustomerOrdersRouter(verifier, new CustomerOrderService(data, () => NOW), undefined, undefined, reader));
    app.use(errorHandler);

    expect((await request(app).get(`/customer/orders/${orderId}/delivery-code`)).status).toBe(401);
    expect((await request(app).get(`/customer/orders/${orderId}/delivery-code`).set('Authorization', 'Bearer b')).status).toBe(404);
    const ok = await request(app).get(`/customer/orders/${orderId}/delivery-code`).set('Authorization', 'Bearer a');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ code: '654321' });
  });
});
