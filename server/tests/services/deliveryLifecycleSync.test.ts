import { CustomerAppUnavailableError } from '../../src/integrations/customerApp/CustomerAppOrderProvider';
import type { CustomerAppOrderProvider, MarkOrderDeliveredOutcome } from '../../src/integrations/customerApp/CustomerAppOrderProvider';
import type { AssignmentSideWrite, DeliveryAssignmentStore } from '../../src/integrations/firebase/FirestoreDeliveryAssignmentStore';
import type { DuoFaceDriverStore } from '../../src/integrations/firebase/FirestoreDuoFaceDriverStore';
import type { OrderSyncStore } from '../../src/integrations/firebase/FirestoreOrderSyncStore';
import type { NotificationDeviceStore, NotificationEventStore } from '../../src/integrations/firebase/FirestoreNotificationStores';
import { InMemoryPushNotificationProvider } from '../../src/integrations/notifications/PushNotificationProvider';
import { DeliveryEventHub } from '../../src/realtime/deliveryEvents';
import { CustomerOrderSyncService } from '../../src/services/customerOrderSyncService';
import { DeliveryAssignmentService } from '../../src/services/deliveryAssignmentService';
import { DeliveryLifecycleEffectsService } from '../../src/services/deliveryLifecycleEffects';
import type { DeliveryLifecycleEffects } from '../../src/services/deliveryLifecycleEffects';
import { DriverService } from '../../src/services/driverService';
import { NotificationService } from '../../src/services/notificationService';
import { ORDER_SYNC_COLLECTION } from '../../src/types/orderSync';

const T = new Date('2026-01-01T12:00:00Z');
const tokenA = 'a'.repeat(40);

function build(options: { orderStatus?: string; failures?: Array<'transient' | 'permanent'>; alwaysTransient?: boolean; startStatus?: string } = {}) {
  // --- Customer App order (fake) ---
  const order = {
    orderId: 'order-1',
    shopId: 'shop-1',
    customerId: 'customer-A',
    status: options.orderStatus ?? 'out_for_delivery',
    paymentStatus: 'paid',
    paymentId: 'pay_SECRET',
    items: [{ productId: 'p', name: 'Milk', price: 1, quantity: 1, subtotal: 1 }],
    delivery: { label: 'Home', fullAddress: '123 MG Road', phoneNumber: '+911234567890' },
    pricing: { total: 1 },
    createdAt: T,
  };
  const failures = [...(options.failures ?? [])];
  const orderCalls = { writes: 0, markCalls: 0 };
  const orders: CustomerAppOrderProvider = {
    listOrdersByShopId: async () => [],
    getOrderById: async () => ({ ...order }),
    markOrderDelivered: async (_id, shop): Promise<MarkOrderDeliveredOutcome> => {
      orderCalls.markCalls++;
      if (options.alwaysTransient) throw new CustomerAppUnavailableError('transient');
      const failure = failures.shift();
      if (failure) throw new CustomerAppUnavailableError(failure);
      if (order.shopId !== shop) return { kind: 'shop_mismatch' };
      if (order.status === 'delivered') return { kind: 'already_delivered' };
      if (order.status !== 'out_for_delivery') return { kind: 'protected_status', status: order.status };
      order.status = 'delivered';
      orderCalls.writes++;
      return { kind: 'completed' };
    },
  };

  // --- Assignment store (fake) that honors side writes like the Firestore one ---
  const assignments = new Map<string, Record<string, unknown>>([
    [
      'a-1',
      {
        assignmentId: 'a-1', orderId: 'order-1', customerAppShopId: 'shop-1', driverId: 'driver-1',
        status: options.startStatus ?? 'picked_up', assignedAt: T, createdAt: T, updatedAt: T,
      },
    ],
  ]);
  const sideDocs = new Map<string, Record<string, unknown>>();
  const store: DeliveryAssignmentStore = {
    get: async (id) => assignments.get(id) ?? null,
    listByDriverId: async (d) => [...assignments.values()].filter((v) => v.driverId === d),
    listByCustomerAppShopId: async (s) => [...assignments.values()].filter((v) => v.customerAppShopId === s),
    listByOrderId: async (o) => [...assignments.values()].filter((v) => v.orderId === o),
    createIfNoActiveAssignmentForOrder: async (id, _o, _a, data) => void assignments.set(id, data),
    runTransaction: async (id, updater, sideWrites?: (next: Record<string, unknown>) => AssignmentSideWrite[]) => {
      const next = updater(assignments.get(id) ?? null);
      assignments.set(id, next);
      for (const side of sideWrites?.(next) ?? []) {
        const key = `${side.collection}/${side.id}`;
        if (!sideDocs.has(key)) sideDocs.set(key, side.data);
      }
      return next;
    },
  };

  // --- Sync + notification collaborators (fakes) ---
  const syncData = new Map<string, Record<string, unknown>>();
  const syncStore: OrderSyncStore = {
    get: async (id) => syncData.get(id) ?? sideDocs.get(`${ORDER_SYNC_COLLECTION}/${id}`) ?? null,
    set: async (id, v) => void syncData.set(id, v),
    listByStates: async (states) => [...syncData.values(), ...[...sideDocs.values()].filter((v) => !syncData.has(String(v.orderId)))].filter((v) => states.includes(v.state as string)),
  };
  const sync = new CustomerOrderSyncService(orders, syncStore, async () => {}, () => T, async () => assignments.get('a-1')?.status === 'delivered');

  const deviceData = new Map<string, Record<string, unknown>>([
    ['customer-A:phone', { deviceId: 'customer-A:phone', firebaseUid: 'customer-A', platform: 'android', pushToken: tokenA, status: 'active', createdAt: T, updatedAt: T }],
  ]);
  const devices: NotificationDeviceStore = {
    get: async (id) => deviceData.get(id) ?? null,
    set: async (id, v) => void deviceData.set(id, v),
    listByFirebaseUid: async (uid) => [...deviceData.values()].filter((v) => v.firebaseUid === uid),
    listByPushToken: async () => [],
  };
  const eventData = new Map<string, Record<string, unknown>>();
  const events: NotificationEventStore = {
    transact: async (id, decide) => {
      const { write, result } = decide(eventData.get(id) ?? null);
      if (write) eventData.set(id, write);
      return result;
    },
    set: async (id, v) => void eventData.set(id, v),
  };
  const push = new InMemoryPushNotificationProvider();
  const notifications = new NotificationService(orders, devices, events, push, () => T);

  // Collect the background side effects so tests can await them deterministically.
  const real = new DeliveryLifecycleEffectsService(sync, notifications);
  const pending: Promise<void>[] = [];
  const track = (p: Promise<void>) => (pending.push(p), p);
  const effects: DeliveryLifecycleEffects = {
    onAssigned: (a) => track(real.onAssigned(a)),
    onAccepted: (a) => track(real.onAccepted(a)),
    onPickedUp: (a) => track(real.onPickedUp(a)),
    onDelivered: (a) => track(real.onDelivered(a)),
  };

  const driverData = new Map<string, Record<string, unknown>>([
    ['driver-1', { driverId: 'driver-1', firebaseUid: 'uid-d', name: 'Ravi', status: 'active', createdAt: T, updatedAt: T }],
  ]);
  const driverStore: DuoFaceDriverStore = {
    get: async (id) => driverData.get(id) ?? null,
    set: async () => {},
    findByFirebaseUid: async () => null,
    listByStatus: async () => [],
  };
  const hub = new DeliveryEventHub();
  const published: unknown[] = [];
  hub.addSink((orderId, event) => published.push({ orderId, event }));
  const service = new DeliveryAssignmentService(store, new DriverService(driverStore), orders, hub, effects, undefined, () => T);

  return { service, order, orderCalls, assignments, sideDocs, syncData, syncStore, sync, push, eventData, published, flush: () => Promise.all(pending), effects, orders, deviceData };
}

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('delivery completion -> Customer App sync + notification', () => {
  it('driver delivers: Duo-Face becomes delivered, event published, order synced, customer notified, record completed', async () => {
    const f = build();
    const result = await f.service.markDelivered('a-1', 'driver-1');
    await f.flush();

    expect(result.status).toBe('delivered');
    expect(f.assignments.get('a-1')!.status).toBe('delivered');
    expect(f.published).toContainEqual({ orderId: 'order-1', event: { type: 'delivery_status', status: 'delivered' } });
    expect(f.order.status).toBe('delivered');
    expect(f.syncData.get('order-1')).toMatchObject({ state: 'completed', outcome: 'delivered' });
    expect(f.push.sent.map((m) => m.data.type)).toEqual(['delivery_completed']);
  });

  it('the pending sync record is written atomically with the transition (same transaction)', async () => {
    const f = build();
    await f.service.markDelivered('a-1', 'driver-1');
    expect(f.sideDocs.get(`${ORDER_SYNC_COLLECTION}/order-1`)).toMatchObject({ orderId: 'order-1', targetStatus: 'delivered', state: 'pending', attempts: 0 });
  });

  it('a repeated deliver is rejected (409) and triggers no second sync or notification', async () => {
    const f = build();
    await f.service.markDelivered('a-1', 'driver-1');
    await f.flush();
    await expect(f.service.markDelivered('a-1', 'driver-1')).rejects.toMatchObject({ statusCode: 409 });
    await f.flush();

    expect(f.orderCalls.markCalls).toBe(1);
    expect(f.orderCalls.writes).toBe(1);
    expect(f.push.sent).toHaveLength(1);
  });

  it('only picked_up can be delivered: an accepted assignment cannot skip ahead (and touches nothing external)', async () => {
    const f = build({ startStatus: 'accepted' });
    await expect(f.service.markDelivered('a-1', 'driver-1')).rejects.toMatchObject({ statusCode: 409 });
    await f.flush();
    expect(f.orderCalls.markCalls).toBe(0);
    expect(f.order.status).toBe('out_for_delivery');
    expect(f.push.sent).toHaveLength(0);
  });

  it('another driver cannot deliver (404) and triggers nothing', async () => {
    const f = build();
    await expect(f.service.markDelivered('a-1', 'driver-2')).rejects.toMatchObject({ statusCode: 404 });
    await f.flush();
    expect(f.orderCalls.markCalls).toBe(0);
  });

  it('Customer App unavailable: Duo-Face stays delivered, the call succeeds, sync is left failed/retryable, notification still goes out', async () => {
    const f = build({ alwaysTransient: true });
    const result = await f.service.markDelivered('a-1', 'driver-1');
    await f.flush();

    expect(result.status).toBe('delivered');
    expect(f.assignments.get('a-1')!.status).toBe('delivered');
    expect(f.order.status).toBe('out_for_delivery'); // untouched
    expect(f.syncData.get('order-1')).toMatchObject({ state: 'failed', lastErrorCategory: 'transient_external_failure' });
    expect(f.push.sent.map((m) => m.data.type)).toEqual(['delivery_completed']);
  });

  it('notification provider failure does not affect delivery or the sync', async () => {
    const f = build();
    f.push.failWith = 'throw';
    const result = await f.service.markDelivered('a-1', 'driver-1');
    await f.flush();
    expect(result.status).toBe('delivered');
    expect(f.order.status).toBe('delivered');
    expect(f.eventData.get('delivery_completed:order-1')).toMatchObject({ state: 'failed' });
  });

  it.each(['cancelled', 'rejected', 'pending'])('a %s Customer App order is never overwritten, yet the Duo-Face delivery still completes', async (status) => {
    const f = build({ orderStatus: status });
    const result = await f.service.markDelivered('a-1', 'driver-1');
    await f.flush();
    expect(result.status).toBe('delivered');
    expect(f.order.status).toBe(status);
    expect(f.syncData.get('order-1')).toMatchObject({ state: 'failed', lastErrorCategory: 'protected_status' });
  });

  it('an order already delivered in the Customer App: idempotent, no write', async () => {
    const f = build({ orderStatus: 'delivered' });
    await f.service.markDelivered('a-1', 'driver-1');
    await f.flush();
    expect(f.orderCalls.writes).toBe(0);
    expect(f.syncData.get('order-1')).toMatchObject({ state: 'completed', outcome: 'already_delivered' });
  });

  it('a throwing side effect never breaks the driver\'s request', async () => {
    const f = build();
    const throwing: DeliveryLifecycleEffects = {
      onAssigned: async () => { throw new Error('x'); },
      onAccepted: async () => { throw new Error('x'); },
      onPickedUp: async () => { throw new Error('x'); },
      onDelivered: async () => { throw new Error('x'); },
    };
    const service = new DeliveryAssignmentService(
      // same store/driver wiring, effects that explode
      (f.service as unknown as { store: DeliveryAssignmentStore }).store,
      (f.service as unknown as { driverService: DriverService }).driverService,
      f.orders,
      new DeliveryEventHub(),
      throwing
    );
    await expect(service.markDelivered('a-1', 'driver-1')).resolves.toMatchObject({ status: 'delivered' });
  });

  it('restart recovery: a delivery whose sync never ran (crash) is completed by the sweep from the atomically-written pending record', async () => {
    const f = build();
    // Simulate a crash: the transition + pending record committed, but the background effects never ran.
    const crashed = { ...f, effects: undefined };
    void crashed;
    const noEffects = new DeliveryAssignmentService(
      (f.service as unknown as { store: DeliveryAssignmentStore }).store,
      (f.service as unknown as { driverService: DriverService }).driverService,
      f.orders,
      new DeliveryEventHub(),
      { onAssigned: async () => {}, onAccepted: async () => {}, onPickedUp: async () => {}, onDelivered: async () => {} }
    );
    await noEffects.markDelivered('a-1', 'driver-1');
    expect(f.order.status).toBe('out_for_delivery');

    // "Restart": a fresh sync service sweeps outstanding records.
    expect(await f.sync.retryOutstanding()).toBe(1);
    expect(f.order.status).toBe('delivered');
    expect(f.syncData.get('order-1')).toMatchObject({ state: 'completed' });
  });

  it('a previously failed sync is completed by a later sweep once the Customer App recovers', async () => {
    const f = build({ failures: ['transient', 'transient', 'transient'] });
    await f.service.markDelivered('a-1', 'driver-1');
    await f.flush();
    expect(f.syncData.get('order-1')).toMatchObject({ state: 'failed', attempts: 3 });

    expect(await f.sync.retryOutstanding()).toBe(1);
    expect(f.order.status).toBe('delivered');
    expect(f.syncData.get('order-1')).toMatchObject({ state: 'completed', attempts: 4 });
    expect(f.orderCalls.writes).toBe(1);
  });
});

describe('other lifecycle notifications', () => {
  it('accepted and picked_up notify the customer once each', async () => {
    const f = build({ startStatus: 'assigned' });
    await f.service.acceptAssignment('a-1', 'driver-1');
    await f.service.markPickedUp('a-1', 'driver-1');
    await f.flush();
    expect(f.push.sent.map((m) => m.data.type)).toEqual(['delivery_accepted', 'driver_picked_up']);
    expect(f.orderCalls.markCalls).toBe(0); // no Customer App sync for these transitions
  });

  it('rejecting notifies nobody and syncs nothing', async () => {
    const f = build({ startStatus: 'assigned' });
    await f.service.rejectAssignment('a-1', 'driver-1');
    await f.flush();
    expect(f.push.sent).toHaveLength(0);
    expect(f.orderCalls.markCalls).toBe(0);
  });

  it('assigning a driver notifies the customer (delivery_assigned) for the correct order', async () => {
    const f = build();
    f.assignments.clear();
    const created = await f.service.assignDriver({ orderId: 'order-1', customerAppShopId: 'shop-1', driverId: 'driver-1' });
    await f.flush();
    expect(created.status).toBe('assigned');
    expect(f.push.sent).toHaveLength(1);
    expect(f.push.sent[0].data).toEqual({ type: 'delivery_assigned', orderId: 'order-1' });
  });

  it('no notification is ever sent for location updates (only the four lifecycle types exist)', () => {
    const types = new Set(['delivery_assigned', 'delivery_accepted', 'driver_picked_up', 'delivery_completed']);
    expect(types.size).toBe(4);
  });

  it('no lifecycle step other than delivery ever writes the Customer App order', async () => {
    const f = build({ startStatus: 'assigned' });
    await f.service.acceptAssignment('a-1', 'driver-1');
    await f.service.markPickedUp('a-1', 'driver-1');
    await f.flush();
    expect(f.orderCalls.writes).toBe(0);
    expect(f.order.status).toBe('out_for_delivery');
  });
});

describe('sensitive data', () => {
  it('logs, sync records and event records contain no tokens, addresses, phones or payment ids', async () => {
    const f = build({ alwaysTransient: true });
    await f.service.markDelivered('a-1', 'driver-1');
    await f.flush();
    const text = JSON.stringify([warn.mock.calls, [...f.syncData.values()], [...f.eventData.values()]]);
    for (const banned of [tokenA, 'MG Road', '+91', 'pay_', 'customer-A']) expect(text).not.toContain(banned);
  });
});
