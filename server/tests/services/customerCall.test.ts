import express from 'express';
import request from 'supertest';

import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import type { CallLogStore } from '../../src/integrations/firebase/FirestoreCallLogStore';
import type { DeliveryAssignmentStore } from '../../src/integrations/firebase/FirestoreDeliveryAssignmentStore';
import type { DuoFaceDriverStore } from '../../src/integrations/firebase/FirestoreDuoFaceDriverStore';
import type { DuoFaceIdentityStore } from '../../src/integrations/firebase/FirestoreDuoFaceIdentityStore';
import { ExotelClient, TelephonyError } from '../../src/integrations/telephony/ExotelClient';
import { ExotelCallProvider, signCallToken, UnconfiguredCallProvider, verifyCallToken } from '../../src/integrations/telephony/CallProvider';
import type { CallProvider } from '../../src/integrations/telephony/CallProvider';
import { errorHandler } from '../../src/middleware/errorHandler';
import { createDriverAssignmentsRouter } from '../../src/routes/driver/assignments';
import { createExotelWebhookRouter } from '../../src/routes/webhooks/exotel';
import { CALL_WINDOW_MS, CustomerCallService, MAX_CALLS_PER_WINDOW } from '../../src/services/customerCallService';
import { DeliveryAssignmentService } from '../../src/services/deliveryAssignmentService';
import { DriverService } from '../../src/services/driverService';
import { DuoFaceIdentityService } from '../../src/services/duoFaceIdentityService';
import { DuoFaceRoleResolver } from '../../src/services/roleResolver';

const T = new Date('2026-06-01T10:00:00Z');
const DRIVER_PHONE = '+919811100001';
const CUSTOMER_PHONE = '+919876543210';
const WEBHOOK_SECRET = 'webhook-secret-0123456789';

const order = {
  orderId: 'order-1',
  shopId: 'shop-1',
  status: 'pending',
  paymentStatus: 'paid',
  items: [{ productId: 'p', name: 'Milk', price: 28, quantity: 1, subtotal: 28 }],
  delivery: { label: 'Home', fullAddress: '1 Road', phoneNumber: CUSTOMER_PHONE },
  pricing: { total: 28 },
  createdAt: T,
};

function build(
  opts: {
    status?: string;
    driverPhone?: string | null;
    provider?: CallProvider;
    customerPhone?: string | null;
    clock?: { now: number };
  } = {}
) {
  const clock = opts.clock ?? { now: T.getTime() };
  const assignments = new Map<string, Record<string, unknown>>([
    ['a-1', { assignmentId: 'a-1', orderId: 'order-1', customerAppShopId: 'shop-1', driverId: 'driver-1', status: opts.status ?? 'accepted', assignedAt: T, createdAt: T, updatedAt: T }],
  ]);
  const assignmentStore: DeliveryAssignmentStore = {
    get: async (id) => assignments.get(id) ?? null,
    listByDriverId: async () => [],
    listByCustomerAppShopId: async () => [],
    listByOrderId: async () => [],
    createIfNoActiveAssignmentForOrder: async () => {},
    runTransaction: async (id, updater) => updater(assignments.get(id) ?? null),
  };
  const driverDoc = {
    driverId: 'driver-1',
    firebaseUid: 'uid-1',
    name: 'Ravi',
    ...(opts.driverPhone === null ? {} : { phoneNumber: opts.driverPhone ?? DRIVER_PHONE }),
    status: 'active',
    createdAt: T,
    updatedAt: T,
  };
  const driverStore: DuoFaceDriverStore = { get: async () => driverDoc, set: async () => {}, listByStatus: async () => [driverDoc], findByFirebaseUid: async () => driverDoc };
  const driverService = new DriverService(driverStore);
  const orderDoc = { ...order, delivery: { ...order.delivery, ...(opts.customerPhone === null ? { phoneNumber: undefined } : opts.customerPhone ? { phoneNumber: opts.customerPhone } : {}) } };
  const orderProvider = { listOrdersByShopId: async () => [], getOrderById: async (id: string) => (id === 'order-1' ? orderDoc : null), markOrderDelivered: async () => { throw new Error('unused'); } };
  const assignmentService = new DeliveryAssignmentService(assignmentStore, driverService, orderProvider);

  const logData = new Map<string, Record<string, unknown>>();
  const logs: CallLogStore & { data: typeof logData } = {
    data: logData,
    get: async (id) => logData.get(id) ?? null,
    set: async (id, v) => void logData.set(id, v),
    listByAssignmentId: async (a) => [...logData.values()].filter((v) => v.assignmentId === a),
  };

  const placed: Array<{ driverPhone: string; customerPhone: string; callId: string }> = [];
  const provider: CallProvider = opts.provider ?? {
    enabled: true,
    connectCall: async (input) => {
      placed.push(input);
      return { providerCallSid: 'sid-1' };
    },
  };
  const calls = new CustomerCallService(assignmentService, orderProvider, logs, provider, WEBHOOK_SECRET, () => new Date(clock.now));

  const identity: DuoFaceIdentityStore = {
    get: async () => ({ firebaseUid: 'uid-1', role: 'driver', status: 'active', driver: { driverId: 'driver-1' }, createdAt: T, updatedAt: T }),
    set: async () => {},
  };
  const verifier: FirebaseIdentityVerifier = { verifyIdToken: async () => ({ firebaseUid: 'uid-1' }) };
  const app = express();
  app.use(express.json());
  app.use('/driver/assignments', createDriverAssignmentsRouter(verifier, new DuoFaceRoleResolver(new DuoFaceIdentityService(identity)), driverService, assignmentService, undefined, undefined, calls, (_req, _res, next) => next()));
  app.use('/webhooks/exotel', createExotelWebhookRouter(calls));
  app.use(errorHandler);
  return { app, logs, placed, calls, clock, assignments };
}

const auth = { Authorization: 'Bearer token' };
const call = (app: express.Express) => request(app).post('/driver/assignments/a-1/call-customer').set(auth);

describe('POST /driver/assignments/:id/call-customer', () => {
  it('places a masked call and never returns or stores either phone number', async () => {
    const t = build();
    const res = await call(t.app);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ callId: expect.any(String), status: 'connecting' });
    expect(t.placed).toEqual([{ driverPhone: DRIVER_PHONE, customerPhone: CUSTOMER_PHONE, callId: res.body.callId }]);

    const everything = JSON.stringify([res.body, [...t.logs.data.values()]]);
    expect(everything).not.toContain(DRIVER_PHONE);
    expect(everything).not.toContain(CUSTOMER_PHONE);
    expect(t.logs.data.get(res.body.callId)).toMatchObject({ assignmentId: 'a-1', driverId: 'driver-1', providerCallSid: 'sid-1', status: 'initiated' });
  });

  it.each(['assigned', 'delivered', 'rejected'])('refuses while the assignment is %s', async (status) => {
    const t = build({ status });
    expect((await call(t.app)).status).toBe(409);
    expect(t.placed).toHaveLength(0);
  });

  it('allows a call once picked up', async () => {
    expect((await call(build({ status: 'picked_up' }).app)).status).toBe(202);
  });

  it('asks the driver to add their phone number first', async () => {
    const res = await call(build({ driverPhone: null }).app);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/phone number to your profile/);
  });

  it('409 when the order has no customer number', async () => {
    expect((await call(build({ customerPhone: null }).app)).status).toBe(409);
  });

  it('503 when calling is not configured, without dialing', async () => {
    const t = build({ provider: new UnconfiguredCallProvider() });
    const res = await call(t.app);
    expect(res.status).toBe(503);
    expect(t.logs.data.size).toBe(0);
  });

  it('a provider failure is a generic 503 that leaks no number, and is logged as failed', async () => {
    const t = build({
      provider: {
        enabled: true,
        connectCall: async () => {
          throw new Error(`boom ${CUSTOMER_PHONE} ${DRIVER_PHONE}`);
        },
      },
    });
    const res = await call(t.app);
    expect(res.status).toBe(503);
    expect(JSON.stringify(res.body)).not.toContain('+91');
    expect([...t.logs.data.values()][0]).toMatchObject({ status: 'failed' });
  });

  it(`limits to ${MAX_CALLS_PER_WINDOW} calls per assignment per window, then allows again`, async () => {
    const t = build();
    for (let i = 0; i < MAX_CALLS_PER_WINDOW; i++) expect((await call(t.app)).status).toBe(202);
    expect((await call(t.app)).status).toBe(429);
    t.clock.now += CALL_WINDOW_MS + 1000;
    expect((await call(t.app)).status).toBe(202);
  });

  it("is a 404 for another driver's assignment", async () => {
    const t = build();
    t.assignments.set('a-1', { ...t.assignments.get('a-1')!, driverId: 'someone-else' });
    expect((await call(t.app)).status).toBe(404);
  });
});

describe('Exotel status webhook', () => {
  async function placeCall(t: ReturnType<typeof build>) {
    return (await call(t.app)).body.callId as string;
  }
  const hook = (app: express.Express, callId: string, token: string, form: string) =>
    request(app).post(`/webhooks/exotel/call-status?callId=${callId}&t=${token}`).type('form').send(form);

  it('records status and duration for a correctly signed callback', async () => {
    const t = build();
    const callId = await placeCall(t);
    const res = await hook(t.app, callId, signCallToken(WEBHOOK_SECRET, callId), 'Status=completed&ConversationDuration=42');
    expect(res.status).toBe(200);
    expect(t.logs.data.get(callId)).toMatchObject({ status: 'completed', durationSeconds: 42 });
  });

  it('ignores a forged or missing token but still answers 200 (nothing is revealed)', async () => {
    const t = build();
    const callId = await placeCall(t);
    for (const token of ['nope', signCallToken('other-secret-0123456789', callId), '']) {
      expect((await hook(t.app, callId, token, 'Status=failed')).status).toBe(200);
    }
    expect(t.logs.data.get(callId)).toMatchObject({ status: 'initiated' });
  });

  it('a token for one call does not authorise another', async () => {
    const t = build();
    const callId = await placeCall(t);
    await hook(t.app, callId, signCallToken(WEBHOOK_SECRET, 'some-other-call'), 'Status=failed');
    expect(t.logs.data.get(callId)).toMatchObject({ status: 'initiated' });
  });

  it('answers 200 for an unknown call id', async () => {
    const t = build();
    expect((await hook(t.app, 'nope', signCallToken(WEBHOOK_SECRET, 'nope'), 'Status=completed')).status).toBe(200);
  });

  it('call tokens verify in constant time and only for the right id', () => {
    const token = signCallToken(WEBHOOK_SECRET, 'c1');
    expect(verifyCallToken(WEBHOOK_SECRET, 'c1', token)).toBe(true);
    expect(verifyCallToken(WEBHOOK_SECRET, 'c2', token)).toBe(false);
    expect(verifyCallToken(WEBHOOK_SECRET, 'c1', undefined)).toBe(false);
    expect(verifyCallToken(WEBHOOK_SECRET, 'c1', 'short')).toBe(false);
  });
});

describe('ExotelClient / ExotelCallProvider', () => {
  const config = { accountSid: 'acct', apiKey: 'key', apiToken: 'token', host: 'api.in.exotel.com' };

  it('posts a Basic-auth form to Calls/connect with the ExoPhone and a signed callback', async () => {
    const seen: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = [];
    const client = new ExotelClient(config, (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      seen.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ Call: { Sid: 'call-sid-9' } }) };
    }) as never);
    const provider = new ExotelCallProvider(
      { ...config, callerId: '08000000000', publicBaseUrl: 'https://api.example.com/', webhookSecret: WEBHOOK_SECRET },
      client
    );

    await expect(provider.connectCall({ driverPhone: DRIVER_PHONE, customerPhone: CUSTOMER_PHONE, callId: 'c1' })).resolves.toEqual({ providerCallSid: 'call-sid-9' });

    expect(seen[0].url).toBe('https://api.in.exotel.com/v1/Accounts/acct/Calls/connect');
    expect(seen[0].init.headers.Authorization).toBe(`Basic ${Buffer.from('key:token').toString('base64')}`);
    const form = new URLSearchParams(seen[0].init.body);
    expect(form.get('From')).toBe(DRIVER_PHONE); // driver is rung first
    expect(form.get('To')).toBe(CUSTOMER_PHONE);
    expect(form.get('CallerId')).toBe('08000000000');
    expect(form.get('CustomField')).toBe('c1');
    expect(form.get('StatusCallback')).toBe(`https://api.example.com/webhooks/exotel/call-status?callId=c1&t=${signCallToken(WEBHOOK_SECRET, 'c1')}`);
    expect(form.get('TimeLimit')).toBe('600');
  });

  it('rejects non-E.164 numbers before calling Exotel', async () => {
    const fetchSpy = jest.fn();
    const client = new ExotelClient(config, fetchSpy as never);
    await expect(client.connectCall({ from: '9811100001', to: CUSTOMER_PHONE, callerId: 'x', statusCallback: 'https://x', customField: 'c', timeLimitSeconds: 60 })).rejects.toMatchObject({ category: 'invalid_number' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'rejected'],
    [500, 'unavailable'],
  ])('maps HTTP %s to a category-only error (no numbers)', async (status, category) => {
    const client = new ExotelClient(config, (async () => ({ ok: false, status, json: async () => ({}) })) as never);
    const error = await client.connectCall({ from: DRIVER_PHONE, to: CUSTOMER_PHONE, callerId: 'x', statusCallback: 'https://x', customField: 'c', timeLimitSeconds: 60 }).catch((e) => e);
    expect(error).toBeInstanceOf(TelephonyError);
    expect(error.category).toBe(category);
    expect(error.message).not.toContain('+91');
  });

  it('a network failure or timeout is a category-only error', async () => {
    const client = new ExotelClient(config, (async () => {
      throw new Error(`ECONNRESET ${CUSTOMER_PHONE}`);
    }) as never);
    const error = await client.connectCall({ from: DRIVER_PHONE, to: CUSTOMER_PHONE, callerId: 'x', statusCallback: 'https://x', customField: 'c', timeLimitSeconds: 60 }).catch((e) => e);
    expect(error.category).toBe('unavailable');
    expect(error.message).not.toContain('+91');
  });

  it('sendSms posts the DLT fields', async () => {
    const seen: string[] = [];
    const client = new ExotelClient(config, (async (url: string, init: { body: string }) => {
      seen.push(url, init.body);
      return { ok: true, status: 200, json: async () => ({}) };
    }) as never);
    await client.sendSms({ from: 'DUOFAC', to: CUSTOMER_PHONE, body: 'Code 123456', dltEntityId: 'E1', dltTemplateId: 'T1' });
    expect(seen[0]).toBe('https://api.in.exotel.com/v1/Accounts/acct/Sms/send');
    const form = new URLSearchParams(seen[1]);
    expect([form.get('DltEntityId'), form.get('DltTemplateId'), form.get('Body')]).toEqual(['E1', 'T1', 'Code 123456']);
  });
});
