import { createHmac } from 'node:crypto';

import request from 'supertest';

// These tests boot the whole Express app (isolated modules); under a parallel full-suite run that can take a while.
jest.setTimeout(30_000);

const SECRET = 'route-test-secret';

function loadApp(env: Record<string, string | undefined>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  let app!: import('express').Express;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    app = require('../../src/app').app;
  });
  for (const k of Object.keys(env)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  return app;
}

const configured = () =>
  loadApp({ CASHFREE_APP_ID: 'app', CASHFREE_SECRET_KEY: SECRET, PUBLIC_BASE_URL: 'https://api.example.com', CASHFREE_ENV: 'sandbox' });
const unconfigured = () =>
  loadApp({ CASHFREE_APP_ID: undefined, CASHFREE_SECRET_KEY: undefined, PUBLIC_BASE_URL: undefined, CASHFREE_ENV: undefined });

const sign = (raw: string, ts: string) => createHmac('sha256', SECRET).update(ts + raw).digest('base64');

describe('POST /webhooks/cashfree (real app wiring)', () => {
  // Deliberately odd spacing: the signature must be checked over the exact bytes received, not re-serialised JSON.
  const raw = '{ "type" : "PAYMENT_FAILED_WEBHOOK",   "data":{"order":{"order_id":"cf_0123456789abcdef0123456789abcdef"}} }';
  const ts = '1760000000000';

  it('accepts a correctly signed event (signature verified over the raw bytes)', async () => {
    const res = await request(configured())
      .post('/webhooks/cashfree')
      .set('Content-Type', 'application/json')
      .set('x-webhook-timestamp', ts)
      .set('x-webhook-signature', sign(raw, ts))
      .send(raw);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('401 for a changed body, a wrong signature, or missing headers', async () => {
    const app = configured();
    const post = () => request(app).post('/webhooks/cashfree').set('Content-Type', 'application/json');
    expect((await post().set('x-webhook-timestamp', ts).set('x-webhook-signature', sign(raw, ts)).send(raw.replace('FAILED', 'SUCCESS'))).status).toBe(401);
    expect((await post().set('x-webhook-timestamp', ts).set('x-webhook-signature', 'nope').send(raw)).status).toBe(401);
    expect((await post().send(raw)).status).toBe(401);
  });

  it('503 when online payment is not configured (even with headers)', async () => {
    const res = await request(unconfigured())
      .post('/webhooks/cashfree')
      .set('Content-Type', 'application/json')
      .set('x-webhook-timestamp', ts)
      .set('x-webhook-signature', sign(raw, ts))
      .send(raw);
    expect(res.status).toBe(503);
  });
});

describe('payment pages', () => {
  const session = 'session_abcDEF123-xyz_=';

  it('checkout page: valid session renders the SDK loader with a locked-down CSP and no caching', async () => {
    const res = await request(configured()).get(`/pay/checkout?session=${session}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('https://sdk.cashfree.com/js/v3/cashfree.js');
    expect(res.text).toContain(`data-session="${session}"`);
    expect(res.text).toContain('data-mode="sandbox"');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain('script-src \'self\' https://sdk.cashfree.com');
  });

  it('checkout page: anything that is not a plain session id is refused (no markup injection)', async () => {
    const app = configured();
    for (const bad of ['', 'short', '"><script>alert(1)</script>aaaaaaaaaa', 'a b c d e f g h i j', `${'a'.repeat(600)}`]) {
      const res = await request(app).get(`/pay/checkout?session=${encodeURIComponent(bad)}`);
      expect(res.status).toBe(400);
      expect(res.text).not.toContain('<script>alert');
    }
    expect((await request(app).get('/pay/checkout')).status).toBe(400);
  });

  it('serves the checkout script and a return page', async () => {
    const app = configured();
    const js = await request(app).get('/pay/checkout.js');
    expect(js.status).toBe(200);
    expect(js.headers['content-type']).toMatch(/javascript/);
    expect(js.text).toContain('redirectTarget');
    const back = await request(app).get('/pay/return');
    expect(back.status).toBe(200);
    expect(back.text).toContain('close this window');
  });
});

describe('customer payment endpoints (real app wiring)', () => {
  it('require sign-in', async () => {
    const app = unconfigured();
    expect((await request(app).post('/customer/orders/x/payment')).status).toBe(401);
    expect((await request(app).post('/customer/orders/x/payment/verify')).status).toBe(401);
    expect((await request(app).get('/customer/config')).status).toBe(401);
  });
});
