import { createHmac } from 'node:crypto';

import { loadCashfreeConfig } from '../../src/config/cashfree';
import {
  CASHFREE_API_VERSION,
  CashfreeGateway,
  gatewayOrderIdFor,
  idempotencyKeyFor,
  PaymentGatewayError,
  refundIdFor,
  toTenDigitPhone,
} from '../../src/integrations/payments/CashfreeGateway';

const config = { appId: 'app-id', secretKey: 'super-secret-key', env: 'sandbox' as const, publicBaseUrl: 'https://api.example.com' };

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const input = {
  gatewayOrderId: 'cf_abc',
  amountPaise: 15950,
  customerId: 'cust1234',
  customerPhone: '9876543210',
  returnUrl: 'https://api.example.com/pay/return',
  notifyUrl: 'https://api.example.com/webhooks/cashfree',
  expiresAt: new Date('2026-10-06T10:15:00Z'),
};

describe('CashfreeGateway.createOrder', () => {
  it('posts the documented request to the sandbox with auth headers and decimal-rupee amount', async () => {
    const { impl, calls } = fakeFetch(200, { order_status: 'ACTIVE', order_amount: 159.5, payment_session_id: 'session_xyz' });
    const result = await new CashfreeGateway(config, impl).createOrder(input);

    expect(result).toEqual({ status: 'ACTIVE', amountPaise: 15950, paymentSessionId: 'session_xyz' });
    expect(calls[0].url).toBe('https://sandbox.cashfree.com/pg/orders');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['x-client-id']).toBe('app-id');
    expect(headers['x-client-secret']).toBe('super-secret-key');
    expect(headers['x-api-version']).toBe(CASHFREE_API_VERSION);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      order_id: 'cf_abc',
      order_amount: 159.5,
      order_currency: 'INR',
      customer_details: { customer_id: 'cust1234', customer_phone: '9876543210' },
      order_meta: { return_url: input.returnUrl, notify_url: input.notifyUrl },
      order_expiry_time: '2026-10-06T10:15:00.000Z',
    });
  });

  it('uses the production host in production', async () => {
    const { impl, calls } = fakeFetch(200, { order_status: 'ACTIVE', order_amount: 1 });
    await new CashfreeGateway({ ...config, env: 'production' }, impl).createOrder(input);
    expect(calls[0].url).toBe('https://api.cashfree.com/pg/orders');
  });
});

describe('CashfreeGateway errors', () => {
  it('maps statuses to safe categories and never leaks the body or keys', async () => {
    for (const [status, category] of [[400, 'rejected'], [401, 'rejected'], [500, 'transient'], [429, 'transient'], [404, 'not_found']] as const) {
      const { impl } = fakeFetch(status, { message: 'secret detail super-secret-key' });
      const err = await new CashfreeGateway(config, impl).createOrder(input).catch((e) => e);
      expect(err).toBeInstanceOf(PaymentGatewayError);
      expect(err.category).toBe(category);
      expect(err.message).not.toContain('super-secret-key');
      expect(err.message).not.toContain('secret detail');
    }
  });

  it('network failure is transient', async () => {
    const impl = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    await expect(new CashfreeGateway(config, impl).getOrder('cf_x')).rejects.toMatchObject({ category: 'transient' });
  });

  it('getOrder returns null for an unknown order and parses statuses', async () => {
    expect(await new CashfreeGateway(config, fakeFetch(404, {}).impl).getOrder('cf_x')).toBeNull();
    const paid = await new CashfreeGateway(config, fakeFetch(200, { order_status: 'PAID', order_amount: 30 }).impl).getOrder('cf_x');
    expect(paid).toEqual({ status: 'PAID', amountPaise: 3000, paymentSessionId: null });
    const weird = await new CashfreeGateway(config, fakeFetch(200, { order_status: 'SOMETHING_NEW', order_amount: 'x' }).impl).getOrder('cf_x');
    expect(weird).toMatchObject({ status: 'UNKNOWN', amountPaise: -1 });
  });
});

describe('webhook signature', () => {
  const gateway = new CashfreeGateway(config, fakeFetch(200, {}).impl);
  const body = '{"type":"PAYMENT_SUCCESS_WEBHOOK","data":{"order":{"order_id":"cf_abc"}}}';
  const ts = '1760000000000';
  const sign = (b: string, t: string, key = config.secretKey) => createHmac('sha256', key).update(t + b).digest('base64');

  it('accepts base64(HMAC-SHA256(timestamp + rawBody))', () => {
    expect(gateway.verifyWebhookSignature(body, ts, sign(body, ts))).toBe(true);
  });
  it('rejects a changed body, timestamp, key or empty values', () => {
    expect(gateway.verifyWebhookSignature(body + ' ', ts, sign(body, ts))).toBe(false);
    expect(gateway.verifyWebhookSignature(body, '1', sign(body, ts))).toBe(false);
    expect(gateway.verifyWebhookSignature(body, ts, sign(body, ts, 'other-key'))).toBe(false);
    expect(gateway.verifyWebhookSignature(body, ts, '')).toBe(false);
    expect(gateway.verifyWebhookSignature('', ts, sign('', ts))).toBe(false);
  });
});

describe('helpers', () => {
  it('gatewayOrderIdFor is deterministic, within 45 chars and valid, even for very long ids', () => {
    const long = `ord_${'x'.repeat(28)}_${'y'.repeat(64)}`;
    const id = gatewayOrderIdFor(long);
    expect(id).toBe(gatewayOrderIdFor(long));
    expect(id).toMatch(/^cf_[a-f0-9]{32}$/);
    expect(id.length).toBeLessThanOrEqual(45);
    expect(gatewayOrderIdFor('other')).not.toBe(id);
  });

  it('toTenDigitPhone accepts Indian mobiles in common forms only', () => {
    expect(toTenDigitPhone('9876543210')).toBe('9876543210');
    expect(toTenDigitPhone('+919876543210')).toBe('9876543210');
    expect(toTenDigitPhone('919876543210')).toBe('9876543210');
    expect(toTenDigitPhone('1234567890')).toBeNull();
    expect(toTenDigitPhone('98765')).toBeNull();
  });

  it('loadCashfreeConfig is null unless fully configured; trims the slash; defaults to sandbox', () => {
    expect(loadCashfreeConfig({})).toBeNull();
    expect(loadCashfreeConfig({ CASHFREE_APP_ID: 'a', CASHFREE_SECRET_KEY: 'b' })).toBeNull(); // no public URL
    const ok = loadCashfreeConfig({ CASHFREE_APP_ID: 'a', CASHFREE_SECRET_KEY: 'b', PUBLIC_BASE_URL: 'https://x.example.com/' });
    expect(ok).toEqual({ appId: 'a', secretKey: 'b', env: 'sandbox', publicBaseUrl: 'https://x.example.com' });
    expect(loadCashfreeConfig({ CASHFREE_APP_ID: 'a', CASHFREE_SECRET_KEY: 'b', PUBLIC_BASE_URL: 'https://x.example.com', CASHFREE_ENV: 'production' })?.env).toBe('production');
    expect(loadCashfreeConfig({ CASHFREE_APP_ID: 'a', CASHFREE_SECRET_KEY: 'b', PUBLIC_BASE_URL: 'https://x.example.com', CASHFREE_ENV: 'live' })).toBeNull();
  });
});

describe('refunds', () => {
  const refund = { gatewayOrderId: 'cf_abc', refundId: 'rf0123', amountPaise: 5700, note: 'Order refund', idempotencyKey: '11111111-2222-4333-8444-555555555555' };

  it('createRefund posts the documented request with the idempotency key', async () => {
    const { impl, calls } = fakeFetch(200, { refund_status: 'PENDING', refund_amount: 57 });
    const result = await new CashfreeGateway(config, impl).createRefund(refund);
    expect(result).toEqual({ status: 'PENDING', amountPaise: 5700 });
    expect(calls[0].url).toBe('https://sandbox.cashfree.com/pg/orders/cf_abc/refunds');
    expect((calls[0].init.headers as Record<string, string>)['x-idempotency-key']).toBe(refund.idempotencyKey);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ refund_amount: 57, refund_id: 'rf0123', refund_note: 'Order refund', refund_speed: 'STANDARD' });
  });

  it('getRefund reads the status, returns null for a refund that does not exist', async () => {
    const found = fakeFetch(200, { refund_status: 'SUCCESS', refund_amount: 57 });
    expect(await new CashfreeGateway(config, found.impl).getRefund('cf_abc', 'rf0123')).toEqual({ status: 'SUCCESS', amountPaise: 5700 });
    expect(found.calls[0].url).toBe('https://sandbox.cashfree.com/pg/orders/cf_abc/refunds/rf0123');
    expect(await new CashfreeGateway(config, fakeFetch(404, {}).impl).getRefund('cf_abc', 'rf0123')).toBeNull();
    expect(await new CashfreeGateway(config, fakeFetch(200, { refund_status: 'NEW_THING' }).impl).getRefund('a', 'b')).toMatchObject({ status: 'UNKNOWN' });
    await expect(new CashfreeGateway(config, fakeFetch(500, {}).impl).getRefund('a', 'b')).rejects.toMatchObject({ category: 'transient' });
  });

  it('refund ids are alphanumeric within 40 chars, stable per attempt, different per attempt/order; idempotency key is a UUID', () => {
    const id = refundIdFor('ord_x', 1);
    expect(id).toMatch(/^rf[a-f0-9]{32}$/);
    expect(id.length).toBeLessThanOrEqual(40);
    expect(refundIdFor('ord_x', 1)).toBe(id);
    expect(refundIdFor('ord_x', 2)).not.toBe(id);
    expect(refundIdFor('ord_y', 1)).not.toBe(id);
    expect(idempotencyKeyFor(id)).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(idempotencyKeyFor(id)).toBe(idempotencyKeyFor(id));
  });
});
