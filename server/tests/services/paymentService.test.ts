import { createHmac } from 'node:crypto';

import { PAYMENT_HOLD_MINUTES } from '../../src/config/cashfree';
import { CashfreeGateway, gatewayOrderIdFor, PaymentGatewayError } from '../../src/integrations/payments/CashfreeGateway';
import type { CreateGatewayOrderInput, CreateGatewayRefundInput, GatewayOrder, GatewayRefund, PaymentGateway } from '../../src/integrations/payments/CashfreeGateway';
import { CustomerOrderService } from '../../src/services/customerOrderService';
import { MerchantOrderService } from '../../src/services/merchantOrderService';
import { OrderStatusService } from '../../src/services/orderStatusService';
import { PaymentService } from '../../src/services/paymentService';
import type { PlaceOrderBody } from '../../src/types/customerOrder';
import { FakeCustomerStore, NOW, seed } from '../helpers/customerFixtures';

const SECRET = 'test-secret';
const BASE = 'https://api.example.com';
const realSigner = new CashfreeGateway({ appId: 'a', secretKey: SECRET, env: 'sandbox', publicBaseUrl: BASE });

class FakeGateway implements PaymentGateway {
  readonly mode = 'sandbox' as const;
  orders = new Map<string, GatewayOrder>();
  created: CreateGatewayOrderInput[] = [];
  terminated: string[] = [];
  down = false;

  async createOrder(input: CreateGatewayOrderInput): Promise<GatewayOrder> {
    if (this.down) throw new PaymentGatewayError('transient');
    if (this.orders.has(input.gatewayOrderId)) throw new PaymentGatewayError('rejected', 409);
    const g: GatewayOrder = { status: 'ACTIVE', amountPaise: input.amountPaise, paymentSessionId: `session_${this.created.length}_abcdefgh` };
    this.orders.set(input.gatewayOrderId, g);
    this.created.push(input);
    return { ...g };
  }
  async getOrder(id: string) {
    if (this.down) throw new PaymentGatewayError('transient');
    const g = this.orders.get(id);
    return g ? { ...g } : null;
  }
  async createRefund(_input: CreateGatewayRefundInput): Promise<GatewayRefund> {
    throw new Error('not used in payment tests');
  }
  async getRefund(): Promise<GatewayRefund | null> {
    throw new Error('not used in payment tests');
  }
  async terminateOrder(id: string) {
    this.terminated.push(id);
    const g = this.orders.get(id);
    if (g?.status === 'ACTIVE') g.status = 'TERMINATED';
  }
  verifyWebhookSignature(raw: string, ts: string, sig: string) {
    return realSigner.verifyWebhookSignature(raw, ts, sig);
  }
  pay(id: string, amountPaise?: number) {
    const g = this.orders.get(id)!;
    g.status = 'PAID';
    if (amountPaise !== undefined) g.amountPaise = amountPaise;
  }
}

const clock = { t: NOW.getTime() };
const now = () => new Date(clock.t);
const MIN = 60_000;

function setup(stock = 5) {
  clock.t = NOW.getTime();
  const store = new FakeCustomerStore();
  seed(store, stock);
  const gateway = new FakeGateway();
  const orders = new CustomerOrderService(store, now, gateway);
  const payments = new PaymentService(orders, gateway, BASE, store, now);
  return { store, gateway, orders, payments };
}

const body = (over: Partial<PlaceOrderBody> = {}): PlaceOrderBody => ({
  clientRequestId: 'req-00000001',
  shopId: 'shop-1',
  addressId: 'addr-1',
  paymentMethod: 'online',
  items: [{ productId: 'p-milk', quantity: 2 }], // 2 x Rs 28.50 = 5700 paise
  ...over,
});

async function placeOnline(ctx: ReturnType<typeof setup>, over: Partial<PlaceOrderBody> = {}) {
  const { order } = await ctx.orders.placeOrder('cust-A', body(over));
  return { orderId: order.orderId, gid: gatewayOrderIdFor(order.orderId) };
}

const milk = (s: FakeCustomerStore) => s.read('duo_face_inventory', 'shop-1__p-milk')!.quantity;
const rawOrder = (s: FakeCustomerStore, id: string) => s.read('orders', id)!;

describe('placing an online order', () => {
  it('reserves stock, waits for payment, and is hidden from the shop', async () => {
    const ctx = setup();
    const { orderId } = await placeOnline(ctx);

    const o = rawOrder(ctx.store, orderId);
    expect(o).toMatchObject({ paymentMethod: 'online', paymentStatus: 'awaiting_payment', status: 'pending' });
    expect(milk(ctx.store)).toBe(3);
    expect(new Date(o.paymentExpiresAt as Date).getTime()).toBe(NOW.getTime() + PAYMENT_HOLD_MINUTES * MIN);

    const merchant = new MerchantOrderService(
      { listOrdersByShopId: async () => [rawOrder(ctx.store, orderId)].map((r) => ({ ...r, orderId })), getOrderById: async () => ({ ...rawOrder(ctx.store, orderId), orderId }), markOrderDelivered: async () => { throw new Error('x'); } },
      { getShop: async (id) => ({ id, name: 'S' }) }
    );
    const shop = { shopId: 'duo', customerAppShopId: 'shop-1' } as never;
    expect(await merchant.listOrders(shop)).toEqual([]);
    expect(await merchant.getOrder(shop, orderId)).toBeNull();
    await expect(new OrderStatusService(ctx.store, now).transition(orderId, 'shop-1', 'confirmed', { type: 'merchant', id: 'm' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('is refused (503) when online payment is not configured, and nothing is reserved', async () => {
    const store = new FakeCustomerStore();
    seed(store, 5);
    const orders = new CustomerOrderService(store, now, null);
    await expect(orders.placeOrder('cust-A', body())).rejects.toMatchObject({ statusCode: 503 });
    expect(milk(store)).toBe(5);
  });

  it('refuses an online order under Rs 1; COD is unaffected', async () => {
    const ctx = setup();
    ctx.store.put('products', 'p-milk', { shopId: 'shop-1', name: 'Milk', price: 0.5, inStock: true });
    await expect(ctx.orders.placeOrder('cust-A', body({ items: [{ productId: 'p-milk', quantity: 1 }] }))).rejects.toMatchObject({ statusCode: 409 });
    expect(milk(ctx.store)).toBe(5);
    const cod = await ctx.orders.placeOrder('cust-A', body({ paymentMethod: 'cod', items: [{ productId: 'p-milk', quantity: 1 }] }));
    expect(cod.order.paymentStatus).toBe('pending');
  });
});

describe('startPayment', () => {
  it('creates the gateway order once and returns the same checkout url on repeat', async () => {
    const ctx = setup();
    const { orderId, gid } = await placeOnline(ctx);
    const first = await ctx.payments.startPayment('cust-A', orderId);
    const second = await ctx.payments.startPayment('cust-A', orderId);

    expect(first.checkoutUrl).toBe(second.checkoutUrl);
    expect(first.checkoutUrl).toMatch(/^https:\/\/api\.example\.com\/pay\/checkout\?session=session_0_/);
    expect(ctx.gateway.created).toHaveLength(1);
    expect(ctx.gateway.created[0]).toMatchObject({
      gatewayOrderId: gid,
      amountPaise: 5700,
      customerId: 'cust-A',
      customerPhone: '9876543210',
      returnUrl: `${BASE}/pay/return`,
      notifyUrl: `${BASE}/webhooks/cashfree`,
    });
    expect(ctx.store.read('duo_face_payments', gid)).toMatchObject({ orderId, amountPaise: 5700, status: 'created', customerId: 'cust-A' });
  });

  it('only the owner, only online orders, only inside the payment window, only with a valid phone', async () => {
    const ctx = setup(20);
    const { orderId } = await placeOnline(ctx);
    await expect(ctx.payments.startPayment('cust-B', orderId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(ctx.payments.startPayment('cust-A', 'missing')).rejects.toMatchObject({ statusCode: 404 });

    const cod = await ctx.orders.placeOrder('cust-A', body({ paymentMethod: 'cod', clientRequestId: 'req-00000002' }));
    await expect(ctx.payments.startPayment('cust-A', cod.order.orderId)).rejects.toMatchObject({ statusCode: 409 });

    const bad = await placeOnline(ctx, { clientRequestId: 'req-00000003' });
    ctx.store.put('orders', bad.orderId, { ...rawOrder(ctx.store, bad.orderId), delivery: { ...(rawOrder(ctx.store, bad.orderId).delivery as object), phoneNumber: '12345' } });
    await expect(ctx.payments.startPayment('cust-A', bad.orderId)).rejects.toMatchObject({ statusCode: 409 });

    clock.t += (PAYMENT_HOLD_MINUTES + 1) * MIN;
    await expect(ctx.payments.startPayment('cust-A', orderId)).rejects.toMatchObject({ statusCode: 409 });
    expect(ctx.gateway.created).toHaveLength(0);
  });

  it('503 when payment is not configured; 502 when the provider is down', async () => {
    const ctx = setup();
    const { orderId } = await placeOnline(ctx);
    await expect(new PaymentService(ctx.orders, null, null, ctx.store, now).startPayment('cust-A', orderId)).rejects.toMatchObject({ statusCode: 503 });
    ctx.gateway.down = true;
    await expect(ctx.payments.startPayment('cust-A', orderId)).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('verify (the customer says they paid)', () => {
  it('never takes the customer’s word: unpaid at Cashfree stays awaiting', async () => {
    const ctx = setup();
    const { orderId } = await placeOnline(ctx);
    await ctx.payments.startPayment('cust-A', orderId);
    const view = await ctx.payments.verify('cust-A', orderId);
    expect(view.paymentStatus).toBe('awaiting_payment');
    expect(milk(ctx.store)).toBe(3);
  });

  it('marks paid once Cashfree says PAID for the exact amount, writes an event, and unlocks the shop', async () => {
    const ctx = setup();
    const { orderId, gid } = await placeOnline(ctx);
    await ctx.payments.startPayment('cust-A', orderId);
    ctx.gateway.pay(gid);

    const view = await ctx.payments.verify('cust-A', orderId);
    expect(view.paymentStatus).toBe('paid');
    expect(view.paymentExpiresAt).toBeNull();
    expect(ctx.store.read('duo_face_payments', gid)).toMatchObject({ status: 'paid', paidAmountPaise: 5700 });
    expect(ctx.store.read('order_events', `${orderId}__payment_paid`)).toMatchObject({ note: 'payment_paid' });
    await expect(new OrderStatusService(ctx.store, now).transition(orderId, 'shop-1', 'confirmed', { type: 'merchant', id: 'm' })).resolves.toBe('confirmed');
  });

  it('a paid-for-the-wrong-amount order is NOT marked paid', async () => {
    const ctx = setup();
    const { orderId, gid } = await placeOnline(ctx);
    await ctx.payments.startPayment('cust-A', orderId);
    ctx.gateway.pay(gid, 100); // Rs 1 paid for a Rs 57 order

    const view = await ctx.payments.verify('cust-A', orderId);
    expect(view.paymentStatus).toBe('awaiting_payment');
    expect(ctx.store.read('duo_face_payments', gid)).toMatchObject({ status: 'amount_mismatch', paidAmountPaise: 100 });
  });

  it("is scoped to the owner and ignores COD orders", async () => {
    const ctx = setup();
    const { orderId } = await placeOnline(ctx);
    await expect(ctx.payments.verify('cust-B', orderId)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('applying the same payment twice is harmless', async () => {
    const ctx = setup();
    const { orderId, gid } = await placeOnline(ctx);
    await ctx.payments.startPayment('cust-A', orderId);
    ctx.gateway.pay(gid);
    expect(await ctx.payments.applyGatewayResult(gid, 5700)).toBe('paid');
    expect(await ctx.payments.applyGatewayResult(gid, 5700)).toBe('already_paid');
    expect(await ctx.payments.applyGatewayResult('cf_unknown', 5700)).toBe('unknown_payment');
  });
});

describe('webhook', () => {
  const sign = (raw: string, ts = '1760000000000') => ({ ts, sig: createHmac('sha256', SECRET).update(ts + raw).digest('base64') });
  const success = (gid: string) => JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: gid, order_amount: 57 }, payment: { payment_status: 'SUCCESS' } } });

  it('rejects a bad signature with 401 and changes nothing', async () => {
    const ctx = setup();
    const { orderId, gid } = await placeOnline(ctx);
    await ctx.payments.startPayment('cust-A', orderId);
    ctx.gateway.pay(gid);
    const raw = success(gid);
    await expect(ctx.payments.handleWebhook(raw, '1', 'bad-signature')).rejects.toMatchObject({ statusCode: 401 });
    await expect(ctx.payments.handleWebhook(raw + ' ', sign(raw).ts, sign(raw).sig)).rejects.toMatchObject({ statusCode: 401 });
    expect(rawOrder(ctx.store, orderId).paymentStatus).toBe('awaiting_payment');
  });

  it('a signed success event marks the order paid after re-confirming with Cashfree', async () => {
    const ctx = setup();
    const { orderId, gid } = await placeOnline(ctx);
    await ctx.payments.startPayment('cust-A', orderId);
    ctx.gateway.pay(gid);
    const raw = success(gid);
    const { ts, sig } = sign(raw);
    expect(await ctx.payments.handleWebhook(raw, ts, sig)).toBe('applied');
    expect(rawOrder(ctx.store, orderId).paymentStatus).toBe('paid');
    expect(await ctx.payments.handleWebhook(raw, ts, sig)).toBe('applied'); // redelivery is fine
  });

  it('does not trust the body: a "success" event while Cashfree says unpaid is ignored', async () => {
    const ctx = setup();
    const { orderId, gid } = await placeOnline(ctx);
    await ctx.payments.startPayment('cust-A', orderId);
    const raw = success(gid);
    const { ts, sig } = sign(raw);
    expect(await ctx.payments.handleWebhook(raw, ts, sig)).toBe('ignored');
    expect(rawOrder(ctx.store, orderId).paymentStatus).toBe('awaiting_payment');
  });

  it('ignores failures, other event types, junk ids and malformed bodies; answers 5xx when Cashfree is unreachable', async () => {
    const ctx = setup();
    const { orderId, gid } = await placeOnline(ctx);
    await ctx.payments.startPayment('cust-A', orderId);
    for (const raw of [
      JSON.stringify({ type: 'PAYMENT_FAILED_WEBHOOK', data: { order: { order_id: gid } } }),
      JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: '../../etc' } } }),
      JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: {} }),
    ]) {
      const { ts, sig } = sign(raw);
      expect(await ctx.payments.handleWebhook(raw, ts, sig)).toBe('ignored');
    }
    const junk = 'not json';
    await expect(ctx.payments.handleWebhook(junk, sign(junk).ts, sign(junk).sig)).rejects.toMatchObject({ statusCode: 400 });

    ctx.gateway.down = true;
    const raw = success(gid);
    await expect(ctx.payments.handleWebhook(raw, sign(raw).ts, sign(raw).sig)).rejects.toMatchObject({ statusCode: 502 });
  });
});

describe('cancelling, expiry and refunds', () => {
  beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('customer cancel of an unpaid online order releases stock and stops the gateway order', async () => {
    const ctx = setup();
    const { orderId, gid } = await placeOnline(ctx);
    await ctx.payments.startPayment('cust-A', orderId);
    const view = await ctx.orders.cancelOrder('cust-A', orderId);
    expect(view.status).toBe('cancelled');
    expect(rawOrder(ctx.store, orderId).paymentStatus).toBe('cancelled');
    expect(milk(ctx.store)).toBe(5);
    expect(ctx.gateway.terminated).toContain(gid);
  });

  it('a payment that arrives after the order was cancelled is flagged for refund, not revived', async () => {
    const ctx = setup();
    const { orderId, gid } = await placeOnline(ctx);
    await ctx.payments.startPayment('cust-A', orderId);
    await ctx.orders.cancelOrder('cust-A', orderId);
    ctx.gateway.orders.get(gid)!.status = 'PAID'; // paid anyway (terminate raced)

    expect(await ctx.payments.applyGatewayResult(gid, 5700)).toBe('needs_refund');
    expect(rawOrder(ctx.store, orderId)).toMatchObject({ status: 'cancelled', refundRequired: true });
    expect(ctx.store.read('duo_face_payments', gid)!.status).toBe('paid_needs_refund');
    expect(milk(ctx.store)).toBe(5); // stock not taken again
  });

  it('a paid online order cannot be cancelled in the app', async () => {
    const ctx = setup();
    const { orderId, gid } = await placeOnline(ctx);
    await ctx.payments.startPayment('cust-A', orderId);
    ctx.gateway.pay(gid);
    await ctx.payments.verify('cust-A', orderId);
    await expect(ctx.orders.cancelOrder('cust-A', orderId)).rejects.toMatchObject({ statusCode: 409 });
    expect(rawOrder(ctx.store, orderId).status).toBe('pending');
  });

  it('the shop rejecting a paid order releases stock and records that a refund is due', async () => {
    const ctx = setup();
    const { orderId, gid } = await placeOnline(ctx);
    await ctx.payments.startPayment('cust-A', orderId);
    ctx.gateway.pay(gid);
    await ctx.payments.verify('cust-A', orderId);
    await new OrderStatusService(ctx.store, now).transition(orderId, 'shop-1', 'rejected', { type: 'merchant', id: 'm' });
    expect(rawOrder(ctx.store, orderId)).toMatchObject({ status: 'rejected', refundRequired: true });
    expect(milk(ctx.store)).toBe(5);
  });

  it('sweep cancels unpaid orders after the hold + grace, restores stock, leaves fresh ones alone', async () => {
    const ctx = setup();
    const old = await placeOnline(ctx, { clientRequestId: 'req-00000001' });
    await ctx.payments.startPayment('cust-A', old.orderId);

    clock.t += PAYMENT_HOLD_MINUTES * MIN + 30_000; // inside the grace period
    expect(await ctx.payments.sweep()).toEqual({ paid: 0, expired: 0 });
    expect(rawOrder(ctx.store, old.orderId).status).toBe('pending');

    const fresh = await placeOnline(ctx, { clientRequestId: 'req-00000002', items: [{ productId: 'p-bread', quantity: 1 }] });
    clock.t += 60_000; // old one now past grace, fresh one is brand new
    expect(await ctx.payments.sweep()).toEqual({ paid: 0, expired: 1 });
    expect(rawOrder(ctx.store, old.orderId)).toMatchObject({ status: 'cancelled', paymentStatus: 'expired', cancellationReason: 'payment_expired' });
    expect(milk(ctx.store)).toBe(5);
    expect(rawOrder(ctx.store, fresh.orderId).status).toBe('pending');
    expect(ctx.store.read('duo_face_payments', old.gid)!.status).toBe('expired');
    expect(ctx.store.read('order_events', `${old.orderId}__pending_cancelled`)).toMatchObject({ actor: { type: 'system', id: 'payment_expiry' } });
  });

  it('sweep never cancels an order that was paid in the meantime (missed webhook)', async () => {
    const ctx = setup();
    const { orderId, gid } = await placeOnline(ctx);
    await ctx.payments.startPayment('cust-A', orderId);
    ctx.gateway.pay(gid);
    clock.t += (PAYMENT_HOLD_MINUTES + 5) * MIN;
    expect(await ctx.payments.sweep()).toEqual({ paid: 1, expired: 0 });
    expect(rawOrder(ctx.store, orderId)).toMatchObject({ status: 'pending', paymentStatus: 'paid' });
    expect(milk(ctx.store)).toBe(3);
  });

  it('sweep survives a provider outage and retries later', async () => {
    const ctx = setup();
    const { orderId } = await placeOnline(ctx);
    await ctx.payments.startPayment('cust-A', orderId);
    clock.t += (PAYMENT_HOLD_MINUTES + 5) * MIN;
    ctx.gateway.down = true;
    expect(await ctx.payments.sweep()).toEqual({ paid: 0, expired: 0 });
    expect(rawOrder(ctx.store, orderId).status).toBe('pending');
    ctx.gateway.down = false;
    expect(await ctx.payments.sweep()).toEqual({ paid: 0, expired: 1 });
  });

  it('an online order that never started payment still expires (no gateway order exists)', async () => {
    const ctx = setup();
    const { orderId } = await placeOnline(ctx);
    clock.t += (PAYMENT_HOLD_MINUTES + 5) * MIN;
    expect(await ctx.payments.sweep()).toEqual({ paid: 0, expired: 1 });
    expect(milk(ctx.store)).toBe(5);
    expect(rawOrder(ctx.store, orderId).paymentStatus).toBe('expired');
  });
});
