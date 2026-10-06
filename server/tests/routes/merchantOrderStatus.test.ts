import express from 'express';
import request from 'supertest';

import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';
import type { DuoFaceShopStore } from '../../src/integrations/firebase/FirestoreDuoFaceShopStore';
import { errorHandler } from '../../src/middleware/errorHandler';
import { createMerchantOrdersRouter } from '../../src/routes/merchant/orders';
import { CustomerOrderService } from '../../src/services/customerOrderService';
import { DeliveryLifecycleEffectsService } from '../../src/services/deliveryLifecycleEffects';
import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import { DuoFaceShopService } from '../../src/services/duoFaceShopService';
import { MerchantOrderService } from '../../src/services/merchantOrderService';
import { OrderStatusService } from '../../src/services/orderStatusService';
import { DuoFaceRoleResolver } from '../../src/services/roleResolver';
import type { DeliveryAssignment } from '../../src/types/deliveryAssignment';
import { FakeCustomerStore, NOW, seed } from '../helpers/customerFixtures';

const kv = (initial: Record<string, Record<string, unknown>>) => new Map(Object.entries(initial));

function buildMerchantApp(store: FakeCustomerStore, merchantUid: string, ownShopId: string) {
  const identities = kv({
    [merchantUid]: { firebaseUid: merchantUid, role: 'merchant', status: 'active', merchant: { shopId: 'duo-shop' }, createdAt: NOW, updatedAt: NOW },
  });
  const shops = kv({
    'duo-shop': { shopId: 'duo-shop', name: 'S', status: 'active', merchantFirebaseUid: merchantUid, customerAppShopId: ownShopId, createdAt: NOW, updatedAt: NOW },
  });
  const identityStore: DuoFaceIdentityStore = { get: async (u) => identities.get(u) ?? null, set: async () => undefined };
  const shopStore: DuoFaceShopStore = {
    get: async (id) => shops.get(id) ?? null,
    set: async () => undefined,
    findByCustomerAppShopId: async () => null,
    findByMerchantFirebaseUid: async () => null,
  };
  const verifier: FirebaseIdentityVerifier = { verifyIdToken: async () => ({ firebaseUid: merchantUid }) };
  const statusService = new OrderStatusService(store, () => NOW);
  const orderService = new MerchantOrderService(
    { listOrdersByShopId: async () => [], getOrderById: async () => null, markOrderDelivered: async () => { throw new Error('unused'); } },
    { getShop: async (id) => ({ id, name: 'S' }) },
    statusService
  );
  const app = express();
  app.use(express.json());
  app.use(
    '/merchant/orders',
    createMerchantOrdersRouter(verifier, new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore)), new DuoFaceShopService(shopStore), orderService)
  );
  app.use(errorHandler);
  return app;
}

async function placeOrder(store: FakeCustomerStore, qty = 2) {
  const orders = new CustomerOrderService(store, () => NOW);
  const { order } = await orders.placeOrder('cust-A', {
    clientRequestId: 'req-00000001',
    shopId: 'shop-1',
    addressId: 'addr-1',
    paymentMethod: 'cod',
    items: [{ productId: 'p-milk', quantity: qty }],
  });
  return order.orderId;
}

const auth = { Authorization: 'Bearer t' };
const stock = (s: FakeCustomerStore) => s.read('duo_face_inventory', 'shop-1__p-milk')!.quantity;
const patch = (app: express.Express, id: string, status: string) =>
  request(app).patch(`/merchant/orders/${id}/status`).set(auth).send({ status });

describe('PATCH /merchant/orders/:orderId/status', () => {
  it('walks pending → confirmed → preparing → ready_for_pickup, recording each event', async () => {
    const store = new FakeCustomerStore();
    seed(store, 5);
    const id = await placeOrder(store);
    const app = buildMerchantApp(store, 'm-1', 'shop-1');

    for (const s of ['confirmed', 'preparing', 'ready_for_pickup']) {
      const res = await patch(app, id, s);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(s);
    }
    expect(store.read('orders', id)!.status).toBe('ready_for_pickup');
    expect(store.read('order_events', `${id}__pending_confirmed`)).toMatchObject({ actor: { type: 'merchant', id: 'duo-shop' } });
    expect(store.read('order_events', `${id}__preparing_ready_for_pickup`)).toBeDefined();
  });

  it('is idempotent: repeating the current status changes nothing', async () => {
    const store = new FakeCustomerStore();
    seed(store, 5);
    const id = await placeOrder(store);
    const app = buildMerchantApp(store, 'm-1', 'shop-1');
    await patch(app, id, 'confirmed');
    expect((await patch(app, id, 'confirmed')).status).toBe(200);
  });

  it('409 for a skipped step or a move out of a terminal status', async () => {
    const store = new FakeCustomerStore();
    seed(store, 5);
    const id = await placeOrder(store);
    const app = buildMerchantApp(store, 'm-1', 'shop-1');
    expect((await patch(app, id, 'preparing')).status).toBe(409);
    expect((await patch(app, id, 'rejected')).status).toBe(200);
    expect((await patch(app, id, 'confirmed')).status).toBe(409);
  });

  it('rejecting restores the stock', async () => {
    const store = new FakeCustomerStore();
    seed(store, 5);
    const id = await placeOrder(store, 3);
    expect(stock(store)).toBe(2);
    await patch(buildMerchantApp(store, 'm-1', 'shop-1'), id, 'rejected');
    expect(stock(store)).toBe(5);
    expect(store.read('orders', id)!.status).toBe('rejected');
  });

  it("404 for another shop's order, and the order is untouched", async () => {
    const store = new FakeCustomerStore();
    seed(store, 5);
    const id = await placeOrder(store);
    const app = buildMerchantApp(store, 'm-2', 'shop-other');
    expect((await patch(app, id, 'confirmed')).status).toBe(404);
    expect(store.read('orders', id)!.status).toBe('pending');
  });

  it('400 for statuses a merchant may not set, extra fields, and no token → 401', async () => {
    const store = new FakeCustomerStore();
    seed(store, 5);
    const id = await placeOrder(store);
    const app = buildMerchantApp(store, 'm-1', 'shop-1');
    for (const s of ['delivered', 'out_for_delivery', 'cancelled', 'pending', 'nonsense']) {
      expect((await patch(app, id, s)).status).toBe(400);
    }
    expect((await request(app).patch(`/merchant/orders/${id}/status`).set(auth).send({ status: 'confirmed', shopId: 'x' })).status).toBe(400);
    expect((await request(app).patch(`/merchant/orders/${id}/status`).send({ status: 'confirmed' })).status).toBe(401);
    expect(store.read('orders', id)!.status).toBe('pending');
  });
});

describe('OrderStatusService.markOutForDelivery', () => {
  const actor = { type: 'driver' as const, id: 'd-1' };

  it('walks every remaining step with an event each, from pending or from ready', async () => {
    const store = new FakeCustomerStore();
    seed(store, 5);
    const id = await placeOrder(store);
    const svc = new OrderStatusService(store, () => NOW);

    expect(await svc.markOutForDelivery(id, 'shop-1', actor)).toBe('out_for_delivery');
    expect(store.read('orders', id)!.status).toBe('out_for_delivery');
    for (const step of ['pending_confirmed', 'confirmed_preparing', 'preparing_ready_for_pickup', 'ready_for_pickup_out_for_delivery']) {
      expect(store.read('order_events', `${id}__${step}`)).toMatchObject({ actor });
    }
    // repeat is a no-op
    expect(await svc.markOutForDelivery(id, 'shop-1', actor)).toBe('out_for_delivery');
  });

  it('never revives a cancelled or rejected order, and refuses another shop', async () => {
    const store = new FakeCustomerStore();
    seed(store, 5);
    const id = await placeOrder(store);
    const svc = new OrderStatusService(store, () => NOW);
    await expect(svc.markOutForDelivery(id, 'other-shop', actor)).rejects.toMatchObject({ statusCode: 404 });
    await new CustomerOrderService(store, () => NOW).cancelOrder('cust-A', id);
    await expect(svc.markOutForDelivery(id, 'shop-1', actor)).rejects.toMatchObject({ statusCode: 409 });
    expect(store.read('orders', id)!.status).toBe('cancelled');
  });
});

describe('driver pickup effect', () => {
  it('onPickedUp moves the order out for delivery and still notifies; a status failure does not block the notification', async () => {
    const store = new FakeCustomerStore();
    seed(store, 5);
    const id = await placeOrder(store);
    const notify = jest.fn().mockResolvedValue('sent');
    const effects = new DeliveryLifecycleEffectsService({} as never, { notify } as never, new OrderStatusService(store, () => NOW));
    const a = { orderId: id, customerAppShopId: 'shop-1', driverId: 'd-1' } as DeliveryAssignment;

    await effects.onPickedUp(a);
    expect(store.read('orders', id)!.status).toBe('out_for_delivery');
    expect(notify).toHaveBeenCalledWith('driver_picked_up', a);

    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    await effects.onPickedUp({ ...a, orderId: 'missing' } as DeliveryAssignment);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
