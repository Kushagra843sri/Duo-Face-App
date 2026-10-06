import express from 'express';
import request from 'supertest';

import { loadAdminUids } from '../../src/config/admin';
import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';
import { gatewayOrderIdFor } from '../../src/integrations/payments/CashfreeGateway';
import type { CreateGatewayRefundInput, GatewayRefund, PaymentGateway } from '../../src/integrations/payments/CashfreeGateway';
import { errorHandler } from '../../src/middleware/errorHandler';
import { createAdminRouter } from '../../src/routes/admin';
import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import { RefundService } from '../../src/services/refundService';
import { DuoFaceRoleResolver } from '../../src/services/roleResolver';
import { FakeCustomerStore, NOW } from '../helpers/customerFixtures';

const tokens: Record<string, string> = {
  'tok-admin': 'admin-1',
  'tok-merchant': 'merchant-1',
  'tok-driver': 'driver-1',
  'tok-customer': 'customer-1',
  'tok-lookalike': 'admin-1x',
};
const verifier: FirebaseIdentityVerifier = {
  verifyIdToken: async (t) => {
    if (!tokens[t]) throw new Error('bad');
    return { firebaseUid: tokens[t] };
  },
};

const identities = new Map<string, Record<string, unknown>>([
  ['merchant-1', { firebaseUid: 'merchant-1', role: 'merchant', status: 'active', merchant: { shopId: 'duo-shop' }, createdAt: NOW, updatedAt: NOW }],
  ['driver-1', { firebaseUid: 'driver-1', role: 'driver', status: 'active', driver: { driverId: 'd-1' }, createdAt: NOW, updatedAt: NOW }],
  // Even a stored identity cannot make someone an admin; only the allowlist does.
  ['admin-1x', { firebaseUid: 'admin-1x', role: 'merchant', status: 'active', merchant: { shopId: 'duo-shop' }, createdAt: NOW, updatedAt: NOW }],
]);
const identityStore: DuoFaceIdentityStore = { get: async (u) => identities.get(u) ?? null, set: async () => undefined };

function gatewayWith(created: CreateGatewayRefundInput[]): PaymentGateway {
  const refunds = new Map<string, GatewayRefund>();
  return {
    mode: 'sandbox',
    createRefund: async (i) => {
      created.push(i);
      const r: GatewayRefund = { status: 'SUCCESS', amountPaise: i.amountPaise };
      refunds.set(i.refundId, r);
      return r;
    },
    getRefund: async (_o, id) => refunds.get(id) ?? null,
    createOrder: async () => {
      throw new Error('unused');
    },
    getOrder: async () => {
      throw new Error('unused');
    },
    terminateOrder: async () => undefined,
    verifyWebhookSignature: () => false,
  };
}

function build() {
  const store = new FakeCustomerStore();
  store.put('orders', 'ord_1', {
    customerId: 'customer-1',
    shopId: 'shop-1',
    shopName: 'Kirana One',
    status: 'rejected',
    paymentMethod: 'online',
    paymentStatus: 'paid',
    refundRequired: true,
    delivery: { phoneNumber: '9876543210' },
    pricingPaise: { total: 5700 },
    createdAt: NOW,
  });
  store.put('duo_face_payments', gatewayOrderIdFor('ord_1'), { status: 'paid', paidAmountPaise: 5700, orderId: 'ord_1' });
  const created: CreateGatewayRefundInput[] = [];
  const refunds = new RefundService(gatewayWith(created), store, () => NOW);
  const resolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore), new Set(['admin-1']));
  const app = express();
  app.use(express.json());
  app.use('/admin', createAdminRouter(verifier, resolver, refunds));
  app.use(errorHandler);
  return { app, store, created };
}

const as = (t: string) => ({ Authorization: `Bearer ${t}` });

describe('who may use /admin', () => {
  const urls: [string, string][] = [
    ['get', '/admin/me'],
    ['get', '/admin/refunds'],
    ['get', '/admin/refunds/ord_1'],
    ['post', '/admin/refunds/ord_1'],
    ['post', '/admin/refunds/ord_1/refresh'],
  ];

  it.each(urls)('%s %s: 401 without or with a bad token', async (method, url) => {
    const { app } = build();
    expect((await (request(app) as never as Record<string, (u: string) => request.Test>)[method](url)).status).toBe(401);
    expect((await (request(app) as never as Record<string, (u: string) => request.Test>)[method](url).set(as('nope'))).status).toBe(401);
  });

  it.each(urls)('%s %s: 403 for a merchant, a driver, a customer and a look-alike uid', async (method, url) => {
    const { app, created, store } = build();
    for (const token of ['tok-merchant', 'tok-driver', 'tok-customer', 'tok-lookalike']) {
      const res = await (request(app) as never as Record<string, (u: string) => request.Test>)[method](url).set(as(token));
      expect(res.status).toBe(403);
    }
    expect(created).toHaveLength(0);
    expect(store.read('orders', 'ord_1')!.refundRequired).toBe(true);
  });

  it('an allowlisted admin gets in', async () => {
    const { app } = build();
    const me = await request(app).get('/admin/me').set(as('tok-admin'));
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ firebaseUid: 'admin-1', role: 'admin' });
  });
});

describe('refund endpoints as admin', () => {
  it('lists, shows, refunds in full and records the admin; the body cannot choose an amount', async () => {
    const { app, created, store } = build();
    const list = await request(app).get('/admin/refunds').set(as('tok-admin'));
    expect(list.status).toBe(200);
    expect(list.body.open.map((r: { orderId: string }) => r.orderId)).toEqual(['ord_1']);
    expect(list.body.open[0].refund.state).toBe('due');

    const detail = await request(app).get('/admin/refunds/ord_1').set(as('tok-admin'));
    expect(detail.body.refund).toMatchObject({ orderId: 'ord_1', paidAmountPaise: 5700 });

    const done = await request(app).post('/admin/refunds/ord_1').set(as('tok-admin')).send({ amountPaise: 1 });
    expect(done.status).toBe(200);
    expect(done.body.refund.refund).toMatchObject({ state: 'refunded', requestedBy: 'admin-1' });
    expect(created).toHaveLength(1);
    expect(created[0].amountPaise).toBe(5700); // the client-sent amount was ignored
    expect(store.read('orders', 'ord_1')!.refundRequired).toBe(false);

    expect((await request(app).post('/admin/refunds/ord_1').set(as('tok-admin'))).status).toBe(409);
    expect(created).toHaveLength(1);
  });

  it('404 for an order with no refund, 409 when nothing is owed', async () => {
    const { app } = build();
    expect((await request(app).get('/admin/refunds/missing').set(as('tok-admin'))).status).toBe(404);
    expect((await request(app).post('/admin/refunds/missing').set(as('tok-admin'))).status).toBe(409);
  });
});

describe('admin allowlist config', () => {
  it('parses a comma separated list, trims and ignores blanks; unset means nobody', () => {
    expect([...loadAdminUids({ ADMIN_FIREBASE_UIDS: ' a1 , b2,, ' })]).toEqual(['a1', 'b2']);
    expect(loadAdminUids({}).size).toBe(0);
    expect(loadAdminUids({ ADMIN_FIREBASE_UIDS: '  ' }).size).toBe(0);
  });

  it('the role resolver honours only exact uids from the list', async () => {
    const resolver = new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore), new Set(['admin-1']));
    expect(await resolver.resolve('admin-1')).toEqual({ firebaseUid: 'admin-1', role: 'admin' });
    expect(await resolver.resolve('Admin-1')).toBeNull();
    expect(await resolver.resolve('admin-1x')).toMatchObject({ role: 'merchant' });
    const nobody = new DuoFaceRoleResolver(new DuoFaceIdentityService(identityStore), new Set());
    expect(await nobody.resolve('admin-1')).toBeNull();
  });
});
