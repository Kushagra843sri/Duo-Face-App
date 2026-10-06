import { gatewayOrderIdFor, PaymentGatewayError } from '../../src/integrations/payments/CashfreeGateway';
import type {
  CreateGatewayOrderInput,
  CreateGatewayRefundInput,
  GatewayOrder,
  GatewayRefund,
  GatewayRefundStatus,
  PaymentGateway,
} from '../../src/integrations/payments/CashfreeGateway';
import { RefundService } from '../../src/services/refundService';
import { FakeCustomerStore, NOW } from '../helpers/customerFixtures';

/** Behaves like Cashfree for refunds: a refund id is unique, repeating it returns the first refund. */
class FakeRefundGateway implements PaymentGateway {
  readonly mode = 'sandbox' as const;
  refunds = new Map<string, GatewayRefund & { input: CreateGatewayRefundInput }>();
  createCalls = 0;
  nextStatus: GatewayRefundStatus = 'SUCCESS';
  createError: PaymentGatewayError | null = null;
  getError: PaymentGatewayError | null = null;

  async createRefund(input: CreateGatewayRefundInput): Promise<GatewayRefund> {
    this.createCalls += 1;
    await Promise.resolve(); // let a concurrent caller interleave
    if (this.createError) throw this.createError;
    const existing = this.refunds.get(input.refundId);
    if (existing) return { status: existing.status, amountPaise: existing.amountPaise };
    const refund = { status: this.nextStatus, amountPaise: input.amountPaise, input };
    this.refunds.set(input.refundId, refund);
    return { status: refund.status, amountPaise: refund.amountPaise };
  }
  async getRefund(_orderId: string, refundId: string): Promise<GatewayRefund | null> {
    await Promise.resolve();
    if (this.getError) throw this.getError;
    const r = this.refunds.get(refundId);
    return r ? { status: r.status, amountPaise: r.amountPaise } : null;
  }
  async createOrder(_i: CreateGatewayOrderInput): Promise<GatewayOrder> {
    throw new Error('unused');
  }
  async getOrder(): Promise<GatewayOrder | null> {
    throw new Error('unused');
  }
  async terminateOrder() {}
  verifyWebhookSignature() {
    return false;
  }
}

const clock = { t: NOW.getTime() };
const now = () => new Date(clock.t);

function setup() {
  clock.t = NOW.getTime();
  const store = new FakeCustomerStore();
  const gateway = new FakeRefundGateway();
  return { store, gateway, refunds: new RefundService(gateway, store, now) };
}

/** An online order that was paid and then rejected by the shop. */
function seedRefundDue(store: FakeCustomerStore, orderId = 'ord_1', overrides: Record<string, unknown> = {}, paymentOverrides: Record<string, unknown> = {}) {
  store.put('orders', orderId, {
    customerId: 'cust-A',
    shopId: 'shop-1',
    shopName: 'Kirana One',
    status: 'rejected',
    paymentMethod: 'online',
    paymentStatus: 'paid',
    refundRequired: true,
    items: [],
    delivery: { label: 'Home', fullAddress: '12 Park Street', phoneNumber: '9876543210' },
    pricingPaise: { subtotal: 5700, deliveryFee: 0, platformFee: 0, total: 5700 },
    createdAt: NOW,
    ...overrides,
  });
  store.put('duo_face_payments', gatewayOrderIdFor(orderId), {
    gatewayOrderId: gatewayOrderIdFor(orderId),
    orderId,
    customerId: 'cust-A',
    status: 'paid',
    amountPaise: 5700,
    paidAmountPaise: 5700,
    ...paymentOverrides,
  });
}

const order = (s: FakeCustomerStore, id = 'ord_1') => s.read('orders', id)!;
const payment = (s: FakeCustomerStore, id = 'ord_1') => s.read('duo_face_payments', gatewayOrderIdFor(id))!;

beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
afterEach(() => jest.restoreAllMocks());

describe('listing', () => {
  it('shows what is owed and what was refunded, and nothing else', async () => {
    const { store, refunds } = setup();
    seedRefundDue(store, 'ord_due');
    seedRefundDue(store, 'ord_done', { refundRequired: false, refund: { status: 'refunded', attempt: 1, refundId: 'x', amountPaise: 5700 } });
    store.put('orders', 'ord_cod', { customerId: 'c', shopId: 's', status: 'cancelled', paymentMethod: 'cod', paymentStatus: 'pending' });

    const { open, refunded } = await refunds.list();
    expect(open.map((r) => r.orderId)).toEqual(['ord_due']);
    expect(open[0]).toMatchObject({
      shopName: 'Kirana One',
      reason: 'rejected_by_shop',
      deliveryPhone: '9876543210',
      totalPaise: 5700,
      paidAmountPaise: 5700,
      refund: { state: 'due', attempt: 0, requestedAt: null },
    });
    expect(refunded.map((r) => r.orderId)).toEqual(['ord_done']);
  });
});

describe('startRefund', () => {
  it('refunds the full amount paid, once, and records who did it', async () => {
    const { store, gateway, refunds } = setup();
    seedRefundDue(store);
    const view = await refunds.startRefund('admin-1', 'ord_1');

    expect(view.refund).toMatchObject({ state: 'refunded', attempt: 1, requestedBy: 'admin-1' });
    expect(gateway.createCalls).toBe(1);
    const sent = [...gateway.refunds.values()][0].input;
    expect(sent.gatewayOrderId).toBe(gatewayOrderIdFor('ord_1'));
    expect(sent.amountPaise).toBe(5700);
    expect(sent.refundId).toMatch(/^rf[a-f0-9]{32}$/);
    expect(sent.idempotencyKey).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);

    expect(order(store)).toMatchObject({ refundRequired: false, refund: { status: 'refunded' } });
    expect(payment(store).status).toBe('refunded');
    expect(store.read('order_events', 'ord_1__refund_requested_1')).toMatchObject({ actor: { type: 'admin', id: 'admin-1' }, note: 'refund_requested' });
    expect(store.read('order_events', 'ord_1__refund_completed')).toMatchObject({ actor: { type: 'admin', id: 'admin-1' } });
  });

  it('refunds what was PAID, not what the order total says', async () => {
    const { store, gateway, refunds } = setup();
    seedRefundDue(store, 'ord_1', {}, { paidAmountPaise: 4000 });
    await refunds.startRefund('admin-1', 'ord_1');
    expect([...gateway.refunds.values()][0].input.amountPaise).toBe(4000);
  });

  it('a double click (two requests at once) creates exactly ONE refund', async () => {
    const { store, gateway, refunds } = setup();
    seedRefundDue(store);
    const results = await Promise.allSettled([refunds.startRefund('admin-1', 'ord_1'), refunds.startRefund('admin-2', 'ord_1')]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(gateway.refunds.size).toBe(1); // the gateway-side truth: one refund id, one refund
    expect(order(store).refund).toMatchObject({ status: 'refunded', attempt: 1 });
  });

  it('refuses a second refund of an already refunded order', async () => {
    const { store, gateway, refunds } = setup();
    seedRefundDue(store);
    await refunds.startRefund('admin-1', 'ord_1');
    await expect(refunds.startRefund('admin-1', 'ord_1')).rejects.toMatchObject({ statusCode: 409 });
    expect(gateway.refunds.size).toBe(1);
  });

  it('refuses when nothing is owed, for COD orders, and without a confirmed payment', async () => {
    const { store, gateway, refunds } = setup();
    seedRefundDue(store, 'ord_not_flagged', { refundRequired: false });
    seedRefundDue(store, 'ord_cod', { paymentMethod: 'cod' });
    seedRefundDue(store, 'ord_nopay', {}, { status: 'created', paidAmountPaise: undefined });
    store.put('orders', 'ord_nopayrec', { ...order(store, 'ord_nopay') });
    for (const id of ['ord_not_flagged', 'ord_cod', 'ord_nopay', 'ord_nopayrec', 'missing']) {
      await expect(refunds.startRefund('admin-1', id)).rejects.toMatchObject({ statusCode: 409 });
    }
    expect(gateway.createCalls).toBe(0);
  });

  it('503 when online payment is not configured', async () => {
    const store = new FakeCustomerStore();
    seedRefundDue(store);
    await expect(new RefundService(null, store, now).startRefund('admin-1', 'ord_1')).rejects.toMatchObject({ statusCode: 503 });
    expect(order(store).refundRequired).toBe(true);
  });
});

describe('refunds that take time or fail', () => {
  it('stays "processing" while Cashfree is pending; Refresh and the timer finish it', async () => {
    const { store, gateway, refunds } = setup();
    seedRefundDue(store);
    gateway.nextStatus = 'PENDING';
    expect((await refunds.startRefund('admin-1', 'ord_1')).refund.state).toBe('processing');
    expect(order(store).refundRequired).toBe(true);

    expect((await refunds.refresh('admin-1', 'ord_1')).refund.state).toBe('processing'); // still pending
    expect(gateway.createCalls).toBe(1); // asking again never creates another

    [...gateway.refunds.values()][0].status = 'SUCCESS';
    expect(await refunds.sweep()).toBe(1);
    expect(order(store)).toMatchObject({ refundRequired: false, refund: { status: 'refunded' } });
    expect(store.read('order_events', 'ord_1__refund_completed')).toMatchObject({ actor: { type: 'system' } });
  });

  it('a refund Cashfree cancels is marked failed and a retry uses a NEW refund id', async () => {
    const { store, gateway, refunds } = setup();
    seedRefundDue(store);
    gateway.nextStatus = 'REJECTED';
    expect((await refunds.startRefund('admin-1', 'ord_1')).refund).toMatchObject({ state: 'failed', attempt: 1 });
    expect(order(store).refundRequired).toBe(true);
    expect(payment(store).status).toBe('refund_failed');
    const firstId = [...gateway.refunds.keys()][0];

    gateway.nextStatus = 'SUCCESS';
    const retried = await refunds.startRefund('admin-1', 'ord_1');
    expect(retried.refund).toMatchObject({ state: 'refunded', attempt: 2 });
    expect(gateway.refunds.size).toBe(2);
    expect([...gateway.refunds.keys()].filter((k) => k !== firstId)).toHaveLength(1);
  });

  it('provider rejects the request (4xx): recorded as failed, can be retried', async () => {
    const { store, gateway, refunds } = setup();
    seedRefundDue(store);
    gateway.createError = new PaymentGatewayError('rejected', 400);
    await expect(refunds.startRefund('admin-1', 'ord_1')).rejects.toMatchObject({ statusCode: 409 });
    expect((await refunds.get('ord_1')).refund.state).toBe('failed');
    gateway.createError = null;
    expect((await refunds.startRefund('admin-1', 'ord_1')).refund.state).toBe('refunded');
  });

  it('provider unreachable: stays "processing" (never lost, never doubled), Refresh completes it', async () => {
    const { store, gateway, refunds } = setup();
    seedRefundDue(store);
    gateway.createError = new PaymentGatewayError('transient');
    await expect(refunds.startRefund('admin-1', 'ord_1')).rejects.toMatchObject({ statusCode: 502 });
    expect((await refunds.get('ord_1')).refund.state).toBe('processing');
    expect(gateway.refunds.size).toBe(0);

    gateway.createError = null;
    expect((await refunds.refresh('admin-1', 'ord_1')).refund.state).toBe('refunded');
    expect(gateway.refunds.size).toBe(1);
  });

  it('clicking Refund again while processing reuses the same refund id', async () => {
    const { store, gateway, refunds } = setup();
    seedRefundDue(store);
    gateway.createError = new PaymentGatewayError('transient');
    await expect(refunds.startRefund('admin-1', 'ord_1')).rejects.toMatchObject({ statusCode: 502 });
    const idAfterFirst = (order(store).refund as { refundId: string }).refundId;
    gateway.createError = null;
    await refunds.startRefund('admin-1', 'ord_1');
    expect([...gateway.refunds.keys()]).toEqual([idAfterFirst]);
    expect(order(store).refund).toMatchObject({ attempt: 1, status: 'refunded' });
  });

  it('sweep survives a provider outage', async () => {
    const { store, gateway, refunds } = setup();
    seedRefundDue(store);
    gateway.nextStatus = 'PENDING';
    await refunds.startRefund('admin-1', 'ord_1');
    gateway.getError = new PaymentGatewayError('transient');
    expect(await refunds.sweep()).toBe(0);
    expect(order(store).refund).toMatchObject({ status: 'processing' });
  });
});
