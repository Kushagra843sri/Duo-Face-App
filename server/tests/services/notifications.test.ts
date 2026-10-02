import express from 'express';
import request from 'supertest';

import { errorHandler } from '../../src/middleware/errorHandler';
import { createCustomerNotificationsRouter, DEVICE_REGISTRATION_RATE_LIMIT } from '../../src/routes/customer/notifications';
import type { CustomerAppOrderProvider } from '../../src/integrations/customerApp/CustomerAppOrderProvider';
import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import type { NotificationDeviceStore, NotificationEventStore } from '../../src/integrations/firebase/FirestoreNotificationStores';
import { InMemoryPushNotificationProvider, NoopPushNotificationProvider } from '../../src/integrations/notifications/PushNotificationProvider';
import { NotificationDeviceService } from '../../src/services/notificationDeviceService';
import { NotificationService } from '../../src/services/notificationService';

const T = new Date('2026-01-01T12:00:00Z');
const tokenA = 'a'.repeat(40);
const tokenB = 'b'.repeat(40);
const tokenC = 'c'.repeat(40);

function deviceStore(initial: Record<string, Record<string, unknown>> = {}) {
  const data = new Map(Object.entries(initial));
  const store: NotificationDeviceStore & { data: Map<string, Record<string, unknown>> } = {
    data,
    get: async (id) => data.get(id) ?? null,
    set: async (id, value) => void data.set(id, value),
    listByFirebaseUid: async (uid) => [...data.values()].filter((v) => v.firebaseUid === uid),
    listByPushToken: async (token) => [...data.values()].filter((v) => v.pushToken === token),
  };
  return store;
}

function eventStore() {
  const data = new Map<string, Record<string, unknown>>();
  const store: NotificationEventStore & { data: Map<string, Record<string, unknown>> } = {
    data,
    transact: async (id, decide) => {
      const { write, result } = decide(data.get(id) ?? null);
      if (write) data.set(id, write);
      return result;
    },
    set: async (id, value) => void data.set(id, value),
  };
  return store;
}

function device(uid: string, deviceId: string, pushToken: string, status = 'active') {
  return { deviceId: `${uid}:${deviceId}`, firebaseUid: uid, platform: 'android', pushToken, status, createdAt: T, updatedAt: T };
}

function orders(doc: Record<string, unknown> | null): CustomerAppOrderProvider & { writes: number } {
  const provider = {
    writes: 0,
    listOrdersByShopId: async () => [],
    getOrderById: async () => doc,
    markOrderDelivered: async () => {
      provider.writes++;
      throw new Error('notifications must never write orders');
    },
  };
  return provider;
}

const orderDoc = {
  orderId: 'order-1',
  shopId: 'shop-1',
  customerId: 'customer-A',
  paymentId: 'pay_SECRET',
  delivery: { fullAddress: '123 MG Road', phoneNumber: '+911234567890' },
};
const assignmentRef = { orderId: 'order-1', customerAppShopId: 'shop-1' };

function build(options: { devices?: Record<string, Record<string, unknown>>; order?: Record<string, unknown> | null; provider?: InMemoryPushNotificationProvider } = {}) {
  const devices = deviceStore(options.devices ?? { 'customer-A:phone': device('customer-A', 'phone', tokenA) });
  const events = eventStore();
  const provider = options.provider ?? new InMemoryPushNotificationProvider();
  const orderProvider = orders(options.order === undefined ? orderDoc : options.order);
  const service = new NotificationService(orderProvider, devices, events, provider, () => T);
  return { service, devices, events, provider, orderProvider };
}

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('NotificationService', () => {
  it.each(['delivery_assigned', 'delivery_accepted', 'driver_picked_up', 'delivery_completed'] as const)('sends %s with a minimal payload', async (type) => {
    const { service, provider } = build();
    expect(await service.notify(type, assignmentRef)).toBe('sent');
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0].data).toEqual({ type, orderId: 'order-1' });
    expect(provider.sent[0].token).toBe(tokenA);
  });

  it('never puts address, phone, payment, ids of people, or coordinates in a message', async () => {
    const { service, provider } = build();
    await service.notify('delivery_completed', assignmentRef);
    const text = JSON.stringify(provider.sent[0]).replace(tokenA, '');
    for (const banned of ['MG Road', '+91', 'pay_SECRET', 'customer-A', 'driver', 'latitude', 'longitude', 'shop-1']) {
      expect(text).not.toContain(banned);
    }
  });

  it('notifies every active device of the order\'s customer, and only those', async () => {
    const { service, provider } = build({
      devices: {
        'customer-A:phone': device('customer-A', 'phone', tokenA),
        'customer-A:tablet': device('customer-A', 'tablet', tokenB),
        'customer-A:old': device('customer-A', 'old', tokenC, 'disabled'),
        'customer-B:phone': device('customer-B', 'phone', 'd'.repeat(40)),
      },
    });
    expect(await service.notify('driver_picked_up', assignmentRef)).toBe('sent');
    expect(provider.sent.map((m) => m.token).sort()).toEqual([tokenA, tokenB]);
  });

  it('a customer without devices is recorded as done (no retry storm)', async () => {
    const { service, events } = build({ devices: {} });
    expect(await service.notify('delivery_completed', assignmentRef)).toBe('no_devices');
    expect(events.data.get('delivery_completed:order-1')).toMatchObject({ state: 'sent', deliveredCount: 0 });
  });

  it('is idempotent: the same logical event is sent once, even when triggered repeatedly', async () => {
    const { service, provider } = build();
    expect(await service.notify('delivery_completed', assignmentRef)).toBe('sent');
    expect(await service.notify('delivery_completed', assignmentRef)).toBe('duplicate');
    expect(await service.notify('delivery_completed', assignmentRef)).toBe('duplicate');
    expect(provider.sent).toHaveLength(1);
  });

  it('different event types for the same order are independent', async () => {
    const { service, provider } = build();
    await service.notify('driver_picked_up', assignmentRef);
    await service.notify('delivery_completed', assignmentRef);
    expect(provider.sent.map((m) => m.data.type)).toEqual(['driver_picked_up', 'delivery_completed']);
  });

  it('a concurrent duplicate does not double-send while the first is in flight', async () => {
    const { service, provider } = build();
    const results = await Promise.all([service.notify('delivery_completed', assignmentRef), service.notify('delivery_completed', assignmentRef)]);
    expect(results.filter((r) => r === 'sent')).toHaveLength(1);
    expect(provider.sent).toHaveLength(1);
  });

  it('a provider that throws is contained: result failed, recorded, and a later trigger may retry', async () => {
    const provider = new InMemoryPushNotificationProvider();
    provider.failWith = 'throw';
    const { service, events } = build({ provider });

    expect(await service.notify('delivery_completed', assignmentRef)).toBe('failed');
    expect(events.data.get('delivery_completed:order-1')).toMatchObject({ state: 'failed', lastErrorCategory: 'provider_failure' });

    provider.failWith = null;
    expect(await service.notify('delivery_completed', assignmentRef)).toBe('sent');
    expect(provider.sent).toHaveLength(1);
  });

  it('a partially failed batch still counts as sent; invalid tokens disable that device only', async () => {
    const provider = new InMemoryPushNotificationProvider();
    provider.failWith = (message) => (message.token === tokenB ? 'invalid_token' : 'sent');
    const { service, devices } = build({
      provider,
      devices: {
        'customer-A:phone': device('customer-A', 'phone', tokenA),
        'customer-A:tablet': device('customer-A', 'tablet', tokenB),
      },
    });
    expect(await service.notify('delivery_completed', assignmentRef)).toBe('sent');
    expect(devices.data.get('customer-A:tablet')).toMatchObject({ status: 'disabled' });
    expect(devices.data.get('customer-A:phone')).toMatchObject({ status: 'active' });
  });

  it('does nothing when the provider is disabled (no record, no calls)', async () => {
    const devices = deviceStore({ 'customer-A:phone': device('customer-A', 'phone', tokenA) });
    const events = eventStore();
    const service = new NotificationService(orders(orderDoc), devices, events, new NoopPushNotificationProvider(), () => T);
    expect(await service.notify('delivery_completed', assignmentRef)).toBe('disabled');
    expect(events.data.size).toBe(0);
  });

  it('refuses to notify when the order does not match the assignment (wrong shop / missing order / no customer)', async () => {
    for (const doc of [{ ...orderDoc, shopId: 'other-shop' }, null, { ...orderDoc, customerId: undefined }, { ...orderDoc, orderId: 'x' }]) {
      const { service, provider } = build({ order: doc });
      expect(await service.notify('delivery_completed', assignmentRef)).toBe('skipped_inconsistent');
      expect(provider.sent).toHaveLength(0);
    }
  });

  it('never writes the Customer App order and never stores tokens in event records or logs', async () => {
    const { service, events, orderProvider } = build();
    await service.notify('delivery_completed', assignmentRef);
    expect(orderProvider.writes).toBe(0);
    const text = JSON.stringify([[...events.data.values()], warn.mock.calls]);
    expect(text).not.toContain(tokenA);
    expect(text).not.toContain('customer-A');
  });

  it('swallows internal errors (never throws into the delivery flow)', async () => {
    const broken: CustomerAppOrderProvider = { ...orders(orderDoc), getOrderById: async () => { throw new Error('boom'); } };
    const service = new NotificationService(broken, deviceStore(), eventStore(), new InMemoryPushNotificationProvider(), () => T);
    await expect(service.notify('delivery_completed', assignmentRef)).resolves.toBe('failed');
  });
});

describe('device registration API', () => {
  const tokens: Record<string, string> = { 'token-A': 'customer-A', 'token-B': 'customer-B' };
  const verifier: FirebaseIdentityVerifier = {
    verifyIdToken: async (token) => {
      const firebaseUid = tokens[token];
      if (!firebaseUid) throw new Error('bad');
      return { firebaseUid };
    },
  };
  const asA = { Authorization: 'Bearer token-A' };
  const asB = { Authorization: 'Bearer token-B' };
  const body = { deviceId: 'phone-1', platform: 'android', pushToken: tokenA };

  function appWith(store = deviceStore()) {
    const app = express();
    app.use(express.json());
    app.use('/customer/notifications', createCustomerNotificationsRouter(verifier, new NotificationDeviceService(store, () => T)));
    app.use(errorHandler);
    return { app, store };
  }

  it('401 without / with an invalid token', async () => {
    const { app } = appWith();
    expect((await request(app).post('/customer/notifications/device').send(body)).status).toBe(401);
    expect((await request(app).post('/customer/notifications/device').set({ Authorization: 'Bearer x' }).send(body)).status).toBe(401);
  });

  it('registers a device under the verified UID and never returns the push token', async () => {
    const { app, store } = appWith();
    const response = await request(app).post('/customer/notifications/device').set(asA).send(body);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ deviceId: 'phone-1', platform: 'android', status: 'active' });
    expect(JSON.stringify(response.body)).not.toContain(tokenA);
    expect(store.data.get('customer-A:phone-1')).toMatchObject({ firebaseUid: 'customer-A', pushToken: tokenA, status: 'active' });
  });

  it.each([
    ['missing deviceId', { platform: 'android', pushToken: tokenA }],
    ['bad platform', { ...body, platform: 'windows' }],
    ['short token', { ...body, pushToken: 'short' }],
    ['deviceId with a slash', { ...body, deviceId: 'a/b' }],
    ['empty deviceId', { ...body, deviceId: '' }],
    ['firebaseUid in body', { ...body, firebaseUid: 'customer-B' }],
    ['customerId in body', { ...body, customerId: 'customer-B' }],
  ])('400 for %s and stores nothing', async (_name, payload) => {
    const { app, store } = appWith();
    expect((await request(app).post('/customer/notifications/device').set(asA).send(payload)).status).toBe(400);
    expect(store.data.size).toBe(0);
  });

  it('is idempotent and updates the token/platform on re-registration, keeping createdAt', async () => {
    const { app, store } = appWith();
    await request(app).post('/customer/notifications/device').set(asA).send(body);
    await request(app).post('/customer/notifications/device').set(asA).send(body);
    expect(store.data.size).toBe(1);

    await request(app).post('/customer/notifications/device').set(asA).send({ ...body, platform: 'ios', pushToken: tokenB });
    expect(store.data.size).toBe(1);
    expect(store.data.get('customer-A:phone-1')).toMatchObject({ platform: 'ios', pushToken: tokenB, createdAt: T });
  });

  it('supports multiple devices per user', async () => {
    const { app, store } = appWith();
    await request(app).post('/customer/notifications/device').set(asA).send(body);
    await request(app).post('/customer/notifications/device').set(asA).send({ ...body, deviceId: 'tablet-1', pushToken: tokenB });
    expect([...store.data.values()].filter((d) => d.status === 'active')).toHaveLength(2);
  });

  it('two users choosing the same deviceId never collide or overwrite each other', async () => {
    const { app, store } = appWith();
    await request(app).post('/customer/notifications/device').set(asA).send(body);
    await request(app).post('/customer/notifications/device').set(asB).send({ ...body, pushToken: tokenB });
    expect(store.data.get('customer-A:phone-1')).toMatchObject({ firebaseUid: 'customer-A', pushToken: tokenA, status: 'active' });
    expect(store.data.get('customer-B:phone-1')).toMatchObject({ firebaseUid: 'customer-B', pushToken: tokenB });
  });

  it('a phone taken over by another account stops delivering to the previous account', async () => {
    const { app, store } = appWith();
    await request(app).post('/customer/notifications/device').set(asA).send(body);
    await request(app).post('/customer/notifications/device').set(asB).send({ ...body, deviceId: 'phone-9' }); // same pushToken
    expect(store.data.get('customer-A:phone-1')).toMatchObject({ status: 'disabled' });
    expect(store.data.get('customer-B:phone-9')).toMatchObject({ status: 'active' });
  });

  it('DELETE disables only the caller\'s own device (idempotent, 204)', async () => {
    const { app, store } = appWith();
    await request(app).post('/customer/notifications/device').set(asA).send(body);
    expect((await request(app).delete('/customer/notifications/device/phone-1').set(asB)).status).toBe(204);
    expect(store.data.get('customer-A:phone-1')).toMatchObject({ status: 'active' });
    expect((await request(app).delete('/customer/notifications/device/phone-1').set(asA)).status).toBe(204);
    expect((await request(app).delete('/customer/notifications/device/phone-1').set(asA)).status).toBe(204);
    expect(store.data.get('customer-A:phone-1')).toMatchObject({ status: 'disabled' });
  });

  it('rate limits registration per UID', async () => {
    const { app } = appWith();
    let last = 0;
    for (let i = 0; i < DEVICE_REGISTRATION_RATE_LIMIT.max + 1; i++) {
      last = (await request(app).post('/customer/notifications/device').set(asA).send(body)).status;
    }
    expect(last).toBe(429);
  });

  it('never logs the push token', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const { app } = appWith();
    await request(app).post('/customer/notifications/device').set(asA).send(body);
    expect(JSON.stringify([log.mock.calls, warn.mock.calls])).not.toContain(tokenA);
  });
});
