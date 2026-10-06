/**
 * A ready-to-use marketplace for end-to-end tests, built ONLY through the real
 * HTTP API (the way the apps do it). A test file must declare the module mocks
 * first (see lifecycle.test.ts), then import this.
 */
import request from 'supertest';

import { app } from '../../../src/app';
import { as, UIDS } from './harness';

export const api = {
  get: (uid: string, path: string) => request(app).get(path).set(as(uid)),
  post: (uid: string, path: string, body?: object) => request(app).post(path).set(as(uid)).send(body ?? {}),
  patch: (uid: string, path: string, body: object) => request(app).patch(path).set(as(uid)).send(body),
  put: (uid: string, path: string, body: object) => request(app).put(path).set(as(uid)).send(body),
};

/** Background work (notifications, order sync) is fire-and-forget by design: wait for it. */
export const settle = async (check: () => boolean | Promise<boolean>, what: string) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for: ${what}`);
};

export const inboxTypes = async (uid: string) => ((await api.get(uid, '/notifications')).body.notifications as { type: string }[]).map((n) => n.type);

export const HOME = { latitude: 28.6139, longitude: 77.209 };

export interface Market {
  shopId: string;
  productId: string;
  addressId: string;
}

/** A merchant with an OPEN shop selling one product (`stock` units), and a customer with a saved address. */
export async function setupMarket(options: { merchantUid?: string; customerUid?: string; shopName?: string; stock?: number } = {}): Promise<Market> {
  const merchant = options.merchantUid ?? UIDS.merchant;
  const customer = options.customerUid ?? UIDS.customer;
  /** Every setup step must work: a silent failure here would make the real test meaningless. */
  const ok = (what: string, res: { status: number; body: unknown }, expected: number) => {
    if (res.status !== expected) throw new Error(`setupMarket: ${what} returned ${res.status} ${JSON.stringify(res.body)}`);
    return res;
  };
  ok('register shop', await api.post(merchant, '/auth/register', { intent: 'merchant', shopName: options.shopName ?? 'Fresh Mart' }), 201);
  const shopId = ok('shop lookup', await api.get(merchant, '/merchant/me'), 200).body as { shopId: string };
  const product = ok('create product', await api.post(merchant, '/merchant/products', { name: 'Toned Milk 500 ml', pricePaise: 2850, quantity: options.stock ?? 10 }), 201);
  ok('open shop', await api.put(merchant, '/merchant/shop/open', { isOpen: true }), 200);
  const address = ok('save address', await api.post(customer, '/customer/addresses', { label: 'Home', fullAddress: '12 Park Street, Delhi 110001', phoneNumber: '9876543210', ...HOME }), 201);
  return { shopId: shopId.shopId, productId: (product.body as { productId: string }).productId, addressId: (address.body as { address: { addressId: string } }).address.addressId };
}

let counter = 0;
export const placeOrder = (uid: string, market: Market, quantity = 1, paymentMethod: 'cod' | 'online' = 'cod') =>
  api.post(uid, '/customer/orders', {
    clientRequestId: `e2e-order-${String(++counter).padStart(6, '0')}`,
    shopId: market.shopId,
    addressId: market.addressId,
    paymentMethod,
    items: [{ productId: market.productId, quantity }],
  });
