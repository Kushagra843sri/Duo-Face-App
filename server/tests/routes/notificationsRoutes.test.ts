import express from 'express';
import request from 'supertest';

import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import { InMemoryPushNotificationProvider } from '../../src/integrations/notifications/PushNotificationProvider';
import { errorHandler } from '../../src/middleware/errorHandler';
import { createNotificationsRouter, NOTIFICATIONS_RATE_LIMIT } from '../../src/routes/notifications';
import { NotificationDeviceService } from '../../src/services/notificationDeviceService';
import { Notifier } from '../../src/services/notifier';
import { FakeInbox, fakeDevices } from '../helpers/notificationFakes';

const T0 = new Date('2026-10-06T10:00:00Z');
const tokens: Record<string, string> = { 'tok-a': 'user-a', 'tok-b': 'user-b' };
const verifier: FirebaseIdentityVerifier = {
  verifyIdToken: async (t) => {
    if (!tokens[t]) throw new Error('bad');
    return { firebaseUid: tokens[t] };
  },
};
const as = (t: string) => ({ Authorization: `Bearer ${t}` });

function build() {
  const inbox = new FakeInbox();
  const devices = fakeDevices([]);
  const notifier = new Notifier(inbox, devices.impl, new InMemoryPushNotificationProvider(), () => T0);
  const app = express();
  app.use(express.json());
  app.use('/notifications', createNotificationsRouter(verifier, notifier, new NotificationDeviceService(devices.impl, () => T0)));
  app.use(errorHandler);
  return { app, notifier, devices };
}

const device = { deviceId: 'phone-1', platform: 'android', pushToken: 'x'.repeat(40) };

describe('authentication', () => {
  it.each([
    ['get', '/notifications'],
    ['post', '/notifications/read-all'],
    ['post', '/notifications/abc/read'],
    ['post', '/notifications/device'],
    ['delete', '/notifications/device/phone-1'],
  ] as const)('%s %s needs a signed-in user', async (method, url) => {
    const { app } = build();
    const r = request(app) as never as Record<string, (u: string) => request.Test>;
    expect((await r[method](url)).status).toBe(401);
    expect((await r[method](url).set(as('nope'))).status).toBe(401);
  });
});

describe('inbox', () => {
  it("returns only the caller's own notifications, with the unread count", async () => {
    const { app, notifier } = build();
    await notifier.notify({ recipientUid: 'user-a', type: 'new_order', refId: 'o1', orderId: 'o1' });
    await notifier.notify({ recipientUid: 'user-b', type: 'order_confirmed', refId: 'o2', orderId: 'o2' });

    const a = await request(app).get('/notifications').set(as('tok-a'));
    expect(a.status).toBe(200);
    expect(a.body.unread).toBe(1);
    expect(a.body.notifications).toHaveLength(1);
    expect(a.body.notifications[0]).toMatchObject({ type: 'new_order', title: 'New order', orderId: 'o1', read: false });
    expect(Object.keys(a.body.notifications[0]).sort()).toEqual(['body', 'createdAt', 'id', 'orderId', 'read', 'title', 'type']);

    const b = await request(app).get('/notifications').set(as('tok-b'));
    expect(b.body.notifications.map((n: { type: string }) => n.type)).toEqual(['order_confirmed']);
  });

  it('marks one read, marks all read, and refuses to touch someone else\'s', async () => {
    const { app, notifier } = build();
    await notifier.notify({ recipientUid: 'user-a', type: 'new_order', refId: 'o1', orderId: 'o1' });
    await notifier.notify({ recipientUid: 'user-a', type: 'order_confirmed', refId: 'o2', orderId: 'o2' });
    const list = (await request(app).get('/notifications').set(as('tok-a'))).body.notifications as { id: string }[];

    expect((await request(app).post(`/notifications/${encodeURIComponent(list[0].id)}/read`).set(as('tok-b'))).status).toBe(404);
    expect((await request(app).get('/notifications').set(as('tok-a'))).body.unread).toBe(2);

    expect((await request(app).post(`/notifications/${encodeURIComponent(list[0].id)}/read`).set(as('tok-a'))).status).toBe(204);
    expect((await request(app).get('/notifications').set(as('tok-a'))).body.unread).toBe(1);
    expect((await request(app).post('/notifications/nope/read').set(as('tok-a'))).status).toBe(404);

    const all = await request(app).post('/notifications/read-all').set(as('tok-a'));
    expect(all.body).toEqual({ marked: 1 });
    expect((await request(app).get('/notifications').set(as('tok-a'))).body.unread).toBe(0);
  });
});

describe('devices (any role)', () => {
  it('registers for the verified user only, rejects a body that tries to name a user, and unregisters', async () => {
    const { app, devices } = build();
    expect((await request(app).post('/notifications/device').set(as('tok-a')).send(device)).status).toBe(200);
    expect(devices.store.get('user-a:phone-1')).toMatchObject({ firebaseUid: 'user-a', status: 'active', platform: 'android' });

    expect((await request(app).post('/notifications/device').set(as('tok-a')).send({ ...device, firebaseUid: 'user-b' })).status).toBe(400);
    expect((await request(app).post('/notifications/device').set(as('tok-a')).send({ ...device, pushToken: 'short' })).status).toBe(400);

    // user-b cannot disable user-a's device even with the same deviceId
    expect((await request(app).delete('/notifications/device/phone-1').set(as('tok-b'))).status).toBe(204);
    expect(devices.store.get('user-a:phone-1')).toMatchObject({ status: 'active' });
    expect((await request(app).delete('/notifications/device/phone-1').set(as('tok-a'))).status).toBe(204);
    expect(devices.store.get('user-a:phone-1')).toMatchObject({ status: 'disabled' });
  });
});

describe('rate limit', () => {
  it('slows a runaway client', async () => {
    const { app } = build();
    let last = 0;
    for (let i = 0; i <= NOTIFICATIONS_RATE_LIMIT.max; i++) last = (await request(app).get('/notifications').set(as('tok-a'))).status;
    expect(last).toBe(429);
  });
});
