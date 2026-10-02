import { CustomerAppUnavailableError } from '../../src/integrations/customerApp/CustomerAppOrderProvider';
import type { CustomerAppOrderProvider, MarkOrderDeliveredOutcome } from '../../src/integrations/customerApp/CustomerAppOrderProvider';
import type { OrderSyncStore } from '../../src/integrations/firebase/FirestoreOrderSyncStore';
import {
  CustomerOrderSyncService,
  IMMEDIATE_ATTEMPTS,
} from '../../src/services/customerOrderSyncService';
import { buildPendingOrderSyncRecord, MAX_SYNC_ATTEMPTS } from '../../src/types/orderSync';

const T = new Date('2026-01-01T12:00:00Z');

interface OrderDoc {
  orderId: string;
  shopId: string;
  status: string;
  customerId: string;
  paymentId: string;
  delivery: { fullAddress: string; phoneNumber: string };
}

function makeOrders(doc: OrderDoc | null, options: { failures?: Array<'transient' | 'permanent'>; failReads?: number } = {}) {
  const failures = [...(options.failures ?? [])];
  let failReads = options.failReads ?? 0;
  const state = { doc: doc ? { ...doc } : null, writes: [] as string[], reads: 0, markCalls: 0 };

  const provider: CustomerAppOrderProvider = {
    listOrdersByShopId: async () => [],
    getOrderById: async (id) => {
      state.reads++;
      if (failReads > 0) {
        failReads--;
        throw new Error('firestore: UNAVAILABLE projects/secret-project/databases/(default)');
      }
      return state.doc && state.doc.orderId === id ? { ...state.doc } : null;
    },
    // Mirrors the real provider's compare-and-set semantics.
    markOrderDelivered: async (id, expectedShopId): Promise<MarkOrderDeliveredOutcome> => {
      state.markCalls++;
      const failure = failures.shift();
      if (failure) throw new CustomerAppUnavailableError(failure);
      if (!state.doc || state.doc.orderId !== id) return { kind: 'not_found' };
      if (state.doc.shopId !== expectedShopId) return { kind: 'shop_mismatch' };
      if (state.doc.status === 'delivered') return { kind: 'already_delivered' };
      if (state.doc.status !== 'out_for_delivery') return { kind: 'protected_status', status: state.doc.status };
      state.doc.status = 'delivered';
      state.writes.push('delivered');
      return { kind: 'completed' };
    },
  };
  return { provider, state };
}

function makeStore(initial: Record<string, Record<string, unknown>> = {}) {
  const data = new Map(Object.entries(initial));
  const store: OrderSyncStore & { data: Map<string, Record<string, unknown>> } = {
    data,
    get: async (id) => data.get(id) ?? null,
    set: async (id, value) => void data.set(id, value),
    listByStates: async (states, limit) => [...data.values()].filter((v) => states.includes(v.state as string)).slice(0, limit),
  };
  return store;
}

const order = (overrides: Partial<OrderDoc> = {}): OrderDoc => ({
  orderId: 'order-1',
  shopId: 'shop-1',
  status: 'out_for_delivery',
  customerId: 'customer-A',
  paymentId: 'pay_SECRET',
  delivery: { fullAddress: '123 MG Road', phoneNumber: '+911234567890' },
  ...overrides,
});

function service(orders: ReturnType<typeof makeOrders>, store = makeStore(), delivered: () => Promise<boolean> = async () => true) {
  const sleeps: number[] = [];
  const svc = new CustomerOrderSyncService(orders.provider, store, async (ms) => void sleeps.push(ms), () => T, delivered);
  return { svc, store, sleeps };
}

let warn: jest.SpyInstance;
beforeEach(() => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('CustomerOrderSyncService.syncDelivered — supported transition', () => {
  it('out_for_delivery -> delivered: writes once and records completion', async () => {
    const orders = makeOrders(order());
    const { svc, store } = service(orders);

    expect(await svc.syncDelivered('order-1', 'shop-1')).toBe('completed');
    expect(orders.state.doc!.status).toBe('delivered');
    expect(orders.state.writes).toEqual(['delivered']);
    expect(store.data.get('order-1')).toMatchObject({
      orderId: 'order-1',
      targetStatus: 'delivered',
      state: 'completed',
      attempts: 1,
      outcome: 'delivered',
      completedAt: T,
      lastAttemptAt: T,
    });
  });

  it('only the status changes: no other order field is touched', async () => {
    const orders = makeOrders(order());
    const before = { ...orders.state.doc! };
    await service(orders).svc.syncDelivered('order-1', 'shop-1');
    expect({ ...orders.state.doc!, status: before.status }).toEqual(before);
  });

  it('already delivered is idempotent success and performs no write', async () => {
    const orders = makeOrders(order({ status: 'delivered' }));
    const { svc, store } = service(orders);
    expect(await svc.syncDelivered('order-1', 'shop-1')).toBe('already_delivered');
    expect(orders.state.markCalls).toBe(0);
    expect(store.data.get('order-1')).toMatchObject({ state: 'completed', outcome: 'already_delivered' });
  });

  it.each(['cancelled', 'rejected', 'pending', 'confirmed', 'preparing', 'ready_for_pickup', 'something_new'])(
    'never overwrites a %s order (protected, permanent, recorded)',
    async (status) => {
      const orders = makeOrders(order({ status }));
      const { svc, store } = service(orders);

      expect(await svc.syncDelivered('order-1', 'shop-1')).toBe('protected_status');
      expect(orders.state.doc!.status).toBe(status);
      expect(orders.state.markCalls).toBe(0);
      expect(store.data.get('order-1')).toMatchObject({ state: 'failed', lastErrorCategory: 'protected_status' });
    }
  );

  it('missing order -> not_found (permanent)', async () => {
    const { svc, store } = service(makeOrders(null));
    expect(await svc.syncDelivered('order-1', 'shop-1')).toBe('not_found');
    expect(store.data.get('order-1')).toMatchObject({ state: 'failed', lastErrorCategory: 'not_found' });
  });

  it('an order in a different shop than the assignment is never touched (shop_mismatch)', async () => {
    const orders = makeOrders(order({ shopId: 'other-shop' }));
    const { svc, store } = service(orders);
    expect(await svc.syncDelivered('order-1', 'shop-1')).toBe('shop_mismatch');
    expect(orders.state.doc!.status).toBe('out_for_delivery');
    expect(orders.state.markCalls).toBe(0);
    expect(store.data.get('order-1')).toMatchObject({ lastErrorCategory: 'shop_mismatch' });
  });

  it('the provider itself refuses a shop mismatch even if the service pre-check were bypassed', async () => {
    const orders = makeOrders(order());
    expect(await orders.provider.markOrderDelivered('order-1', 'wrong-shop')).toEqual({ kind: 'shop_mismatch' });
    expect(orders.state.doc!.status).toBe('out_for_delivery');
  });
});

describe('retry, failure and idempotency', () => {
  it('retries a transient failure (with backoff) and then succeeds', async () => {
    const orders = makeOrders(order(), { failures: ['transient', 'transient'] });
    const { svc, store, sleeps } = service(orders);

    expect(await svc.syncDelivered('order-1', 'shop-1')).toBe('completed');
    expect(orders.state.markCalls).toBe(3);
    expect(sleeps).toEqual([500, 2000]);
    expect(store.data.get('order-1')).toMatchObject({ state: 'completed', attempts: 3 });
    expect(orders.state.writes).toEqual(['delivered']); // written exactly once
  });

  it('is bounded: gives up after the immediate attempts and leaves a retryable failed record', async () => {
    const orders = makeOrders(order(), { failures: ['transient', 'transient', 'transient', 'transient'] });
    const { svc, store } = service(orders);

    expect(await svc.syncDelivered('order-1', 'shop-1')).toBe('transient_external_failure');
    expect(orders.state.markCalls).toBe(IMMEDIATE_ATTEMPTS);
    expect(store.data.get('order-1')).toMatchObject({ state: 'failed', attempts: IMMEDIATE_ATTEMPTS, lastErrorCategory: 'transient_external_failure' });
    expect(orders.state.doc!.status).toBe('out_for_delivery');
  });

  it('a permanent external failure is not retried', async () => {
    const orders = makeOrders(order(), { failures: ['permanent'] });
    const { svc, store, sleeps } = service(orders);
    expect(await svc.syncDelivered('order-1', 'shop-1')).toBe('permanent_external_failure');
    expect(orders.state.markCalls).toBe(1);
    expect(sleeps).toEqual([]);
    expect(store.data.get('order-1')).toMatchObject({ state: 'failed', lastErrorCategory: 'permanent_external_failure' });
  });

  it('a read failure is treated as transient and its raw message never reaches the record or logs', async () => {
    const orders = makeOrders(order(), { failReads: IMMEDIATE_ATTEMPTS });
    const { svc, store } = service(orders);
    expect(await svc.syncDelivered('order-1', 'shop-1')).toBe('transient_external_failure');

    const everything = JSON.stringify([[...store.data.values()], warn.mock.calls]);
    expect(everything).not.toContain('secret-project');
    expect(everything).not.toContain('UNAVAILABLE');
  });

  it('repeated synchronization is safe: the second call does nothing', async () => {
    const orders = makeOrders(order());
    const { svc } = service(orders);
    expect(await svc.syncDelivered('order-1', 'shop-1')).toBe('completed');
    expect(await svc.syncDelivered('order-1', 'shop-1')).toBe('already_completed');
    expect(orders.state.markCalls).toBe(1);
    expect(orders.state.writes).toEqual(['delivered']);
  });

  it('the Customer App wrote first (ambiguous earlier failure): retry sees delivered and records success without writing', async () => {
    // First call: the write "happened" server-side but we saw a transient error...
    const orders = makeOrders(order(), { failures: ['transient'] });
    const { svc, store } = service(orders);
    orders.state.doc!.status = 'delivered'; // ...so by the retry the order is already delivered
    expect(await svc.syncDelivered('order-1', 'shop-1')).toBe('already_delivered');
    expect(orders.state.writes).toEqual([]);
    expect(store.data.get('order-1')).toMatchObject({ state: 'completed', outcome: 'already_delivered' });
  });

  it('a permanently failed (protected) record is not re-attempted on later calls', async () => {
    const orders = makeOrders(order({ status: 'cancelled' }));
    const { svc } = service(orders);
    await svc.syncDelivered('order-1', 'shop-1');
    orders.state.reads = 0;
    expect(await svc.syncDelivered('order-1', 'shop-1')).toBe('protected_status');
    expect(orders.state.reads).toBe(0);
  });

  it('stops at the total attempt cap', async () => {
    const store = makeStore({
      'order-1': { ...buildPendingOrderSyncRecord('order-1', T), state: 'failed', attempts: MAX_SYNC_ATTEMPTS, lastErrorCategory: 'transient_external_failure' },
    });
    const orders = makeOrders(order());
    expect(await service(orders, store).svc.syncDelivered('order-1', 'shop-1')).toBe('max_attempts_reached');
    expect(orders.state.markCalls).toBe(0);
  });
});

describe('restart recovery (retryOutstanding)', () => {
  it('completes a record left pending (server restarted after delivery, before sync)', async () => {
    const store = makeStore({ 'order-1': buildPendingOrderSyncRecord('order-1', T) });
    const orders = makeOrders(order());
    const { svc } = service(orders, store);

    expect(await svc.retryOutstanding()).toBe(1);
    expect(orders.state.doc!.status).toBe('delivered');
    expect(store.data.get('order-1')).toMatchObject({ state: 'completed' });
  });

  it('retries a failed-retryable record, but skips permanent, completed and exhausted ones', async () => {
    const store = makeStore({
      a: { ...buildPendingOrderSyncRecord('a', T), state: 'failed', attempts: 3, lastErrorCategory: 'transient_external_failure' },
      b: { ...buildPendingOrderSyncRecord('b', T), state: 'failed', attempts: 1, lastErrorCategory: 'protected_status' },
      c: { ...buildPendingOrderSyncRecord('c', T), state: 'completed', attempts: 1 },
      d: { ...buildPendingOrderSyncRecord('d', T), state: 'failed', attempts: MAX_SYNC_ATTEMPTS, lastErrorCategory: 'transient_external_failure' },
    });
    const orders = makeOrders(order({ orderId: 'a' }));
    const { svc } = service(orders, store);
    expect(await svc.retryOutstanding()).toBe(1);
    expect(orders.state.markCalls).toBe(1);
  });

  it('never writes for a record whose assignment is not delivered', async () => {
    const store = makeStore({ 'order-1': buildPendingOrderSyncRecord('order-1', T) });
    const orders = makeOrders(order());
    const { svc } = service(orders, store, async () => false);
    expect(await svc.retryOutstanding()).toBe(0);
    expect(orders.state.markCalls).toBe(0);
    expect(orders.state.doc!.status).toBe('out_for_delivery');
  });
});

describe('sync record contents', () => {
  it('contains no customer, address, phone, payment, token or raw error data', async () => {
    const orders = makeOrders(order({ status: 'cancelled' }));
    const { svc, store } = service(orders);
    await svc.syncDelivered('order-1', 'shop-1');
    const text = JSON.stringify([...store.data.values()]);
    for (const banned of ['customer-A', 'MG Road', '+91', 'pay_SECRET', 'token', 'stack', 'Exception']) {
      expect(text).not.toContain(banned);
    }
    expect(Object.keys(store.data.get('order-1')!).sort()).toEqual(
      ['attempts', 'createdAt', 'lastAttemptAt', 'lastErrorCategory', 'orderId', 'state', 'targetStatus', 'updatedAt']
    );
  });

  it('logs contain only the order id and a category', async () => {
    const orders = makeOrders(order({ status: 'cancelled' }));
    await service(orders).svc.syncDelivered('order-1', 'shop-1');
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('order-1');
    for (const banned of ['MG Road', '+91', 'pay_SECRET', 'customer-A']) expect(logged).not.toContain(banned);
  });

  it('the provider interface exposes no arbitrary-status writer', () => {
    const provider = makeOrders(order()).provider as unknown as Record<string, unknown>;
    expect(provider.updateOrderStatus).toBeUndefined();
  });
});
