import { InMemoryPushNotificationProvider, NoopPushNotificationProvider } from '../../src/integrations/notifications/PushNotificationProvider';
import { AppEventService } from '../../src/services/appEvents';
import { Notifier, NOTIFICATION_COPY } from '../../src/services/notifier';
import type { NotifyInput } from '../../src/services/notifier';
import { appNotificationTypeSchema } from '../../src/types/notifications';
import { FakeInbox, fakeDevices } from '../helpers/notificationFakes';

type Doc = Record<string, unknown>;
const T0 = new Date('2026-10-06T10:00:00Z');
let clock = T0.getTime();
const now = () => new Date(clock);

const device = (uid: string, n: number, status = 'active'): Doc => ({
  deviceId: `${uid}:d${n}`,
  firebaseUid: uid,
  platform: 'android',
  pushToken: `token-${uid}-${n}-xxxxxxxxxxxxxxxxxxxx`,
  status,
  createdAt: T0,
  updatedAt: T0,
});

function setup(devices: Doc[] = [device('u1', 1), device('u1', 2), device('u2', 1)]) {
  clock = T0.getTime();
  const inbox = new FakeInbox();
  const provider = new InMemoryPushNotificationProvider();
  const d = fakeDevices(devices);
  return { inbox, provider, devices: d, notifier: new Notifier(inbox, d.impl, provider, now) };
}

const input = (over: Partial<NotifyInput> = {}): NotifyInput => ({ recipientUid: 'u1', type: 'new_order', refId: 'order-1', orderId: 'order-1', ...over });

beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
afterEach(() => jest.restoreAllMocks());

describe('copy', () => {
  it('has copy for every notification type, and none of it carries personal data placeholders', () => {
    for (const type of appNotificationTypeSchema.options) {
      const c = NOTIFICATION_COPY[type];
      expect(c.title.length).toBeGreaterThan(2);
      expect(c.body.length).toBeGreaterThan(10);
      expect(`${c.title} ${c.body}`).not.toMatch(/[{}$]|\d{5,}|₹|Rs\.? ?\d/);
    }
  });
});

describe('Notifier.notify', () => {
  it("saves to the recipient's inbox and pushes to that person's active devices only", async () => {
    const { notifier, inbox, provider } = setup();
    expect(await notifier.notify(input())).toBe('sent');

    const [row] = await inbox.list('u1', 10);
    expect(row).toMatchObject({ type: 'new_order', title: 'New order', orderId: 'order-1', readAt: null });
    expect(await inbox.list('u2', 10)).toEqual([]);
    expect(provider.sent.map((m) => m.token).sort()).toEqual(['token-u1-1-xxxxxxxxxxxxxxxxxxxx', 'token-u1-2-xxxxxxxxxxxxxxxxxxxx']);
    expect(provider.sent[0].data).toEqual({ type: 'new_order', orderId: 'order-1' });
    expect(provider.sent[0].body).toBe(NOTIFICATION_COPY.new_order.body);
  });

  it('a notification without an order carries no orderId', async () => {
    const { notifier, provider } = setup();
    await notifier.notify({ recipientUid: 'u1', type: 'kyc_approved', refId: 'driver:d1:1' });
    expect(provider.sent[0].data).toEqual({ type: 'kyc_approved' });
  });

  it('is sent once per recipient + type + reference, however many times the event repeats', async () => {
    const { notifier, inbox, provider } = setup();
    expect(await notifier.notify(input())).toBe('sent');
    expect(await notifier.notify(input())).toBe('duplicate');
    expect(await notifier.notify(input())).toBe('duplicate');
    expect(await inbox.list('u1', 10)).toHaveLength(1);
    expect(provider.sent).toHaveLength(2); // one push per device, once

    expect(await notifier.notify(input({ refId: 'order-2', orderId: 'order-2' }))).toBe('sent'); // another order is a new notification
    expect(await notifier.notify(input({ type: 'order_confirmed' }))).toBe('sent'); // another type too
    expect(await notifier.notify(input({ recipientUid: 'u2' }))).toBe('sent'); // and another person
  });

  it('keeps the notification when push cannot happen: disabled provider, no devices, provider down', async () => {
    const disabled = new Notifier(new FakeInbox(), fakeDevices([device('u1', 1)]).impl, new NoopPushNotificationProvider(), now);
    expect(await disabled.notify(input())).toBe('inbox_only');

    const none = setup([]);
    expect(await none.notifier.notify(input())).toBe('inbox_only');
    expect(await none.inbox.list('u1', 10)).toHaveLength(1);

    const down = setup();
    down.provider.failWith = 'throw';
    expect(await down.notifier.notify(input())).toBe('inbox_only');
    expect(await down.inbox.list('u1', 10)).toHaveLength(1);
  });

  it('ignores disabled devices and switches off a device whose token the provider says is dead', async () => {
    const ctx = setup([device('u1', 1, 'disabled'), device('u1', 2)]);
    await ctx.notifier.notify(input());
    expect(ctx.provider.sent.map((m) => m.token)).toEqual(['token-u1-2-xxxxxxxxxxxxxxxxxxxx']);

    const dead = setup([device('u1', 1)]);
    dead.provider.failWith = 'invalid_token';
    expect(await dead.notifier.notify(input())).toBe('inbox_only');
    expect(dead.devices.store.get('u1:d1')).toMatchObject({ status: 'disabled' });
  });

  it('never throws: a broken inbox store is reported as failed', async () => {
    const ctx = setup();
    ctx.inbox.failCreate = true;
    expect(await ctx.notifier.notify(input())).toBe('failed');
    expect(ctx.provider.sent).toHaveLength(0);
  });
});

describe('inbox reads', () => {
  it('lists newest first with the unread count, and marks read one by one or all at once', async () => {
    const { notifier } = setup();
    await notifier.notify(input({ refId: 'a', type: 'new_order' }));
    clock += 1000;
    await notifier.notify(input({ refId: 'b', type: 'order_confirmed' }));
    clock += 1000;
    await notifier.notify(input({ refId: 'c', type: 'refund_started' }));

    const first = await notifier.list('u1');
    expect(first.unread).toBe(3);
    expect(first.notifications.map((n) => n.type)).toEqual(['refund_started', 'order_confirmed', 'new_order']);
    expect(first.notifications[0]).toMatchObject({ read: false, orderId: 'order-1' });

    await notifier.markRead('u1', first.notifications[0].id);
    expect((await notifier.list('u1')).unread).toBe(2);
    expect(await notifier.markAllRead('u1')).toEqual({ marked: 2 });
    const after = await notifier.list('u1');
    expect(after.unread).toBe(0);
    expect(after.notifications.every((n) => n.read)).toBe(true);
  });

  it("one person cannot read or mark another's notifications", async () => {
    const { notifier } = setup();
    await notifier.notify(input());
    const mine = (await notifier.list('u1')).notifications[0];
    expect((await notifier.list('u2')).notifications).toEqual([]);
    await expect(notifier.markRead('u2', mine.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(notifier.markRead('u1', 'nope')).rejects.toMatchObject({ statusCode: 404 });
    expect((await notifier.list('u1')).unread).toBe(1);
  });

  it('skips rows that are malformed or of a type this server does not know', async () => {
    const { notifier, inbox } = setup();
    await notifier.notify(input());
    await inbox.create('u1', 'weird', { type: 'from_the_future', title: 't', body: 'b', createdAt: now(), readAt: null });
    await inbox.create('u1', 'broken', { type: 'new_order', title: 't', body: 'b', readAt: null });
    expect((await notifier.list('u1')).notifications).toHaveLength(1);
  });
});

describe('AppEventService: who hears about what', () => {
  function events(over: { shopActive?: boolean; driverActive?: boolean; admins?: string[]; orderExists?: boolean } = {}) {
    const sent: { to: string; type: string; ref: string; orderId?: string }[] = [];
    const notifier = { notify: async (i: NotifyInput) => void sent.push({ to: i.recipientUid, type: i.type, ref: i.refId, orderId: i.orderId }) } as unknown as Notifier;
    const orders = { getOrder: async (id: string) => (over.orderExists === false ? null : { orderId: id, customerId: 'cust-1', shopId: 'shop-1' }) };
    const shops = {
      getByCustomerAppShopId: async (id: string) => (id === 'shop-1' ? { status: over.shopActive === false ? 'suspended' : 'active', merchantFirebaseUid: 'merch-1' } : null),
      getById: async (id: string) => (id === 'duo-shop' ? { merchantFirebaseUid: 'merch-1' } : null),
    };
    const drivers = { getById: async (id: string) => (id === 'drv-1' ? { status: over.driverActive === false ? 'suspended' : 'active', firebaseUid: 'drv-uid' } : null) };
    const service = new AppEventService(notifier, orders as never, shops as never, drivers as never, new Set(over.admins ?? ['admin-1', 'admin-2']));
    return { service, sent };
  }
  const assignment = { assignmentId: 'a-1', orderId: 'order-1', customerAppShopId: 'shop-1', driverId: 'drv-1' } as never;

  it('a cash order goes to the shop owner; an unknown order or an inactive shop reaches nobody', async () => {
    const a = events();
    await a.service.orderPlaced('order-1');
    expect(a.sent).toEqual([{ to: 'merch-1', type: 'new_order', ref: 'order-1', orderId: 'order-1' }]);
    const b = events({ shopActive: false });
    await b.service.orderPlaced('order-1');
    expect(b.sent).toEqual([]);
    const c = events({ orderExists: false });
    await c.service.orderPlaced('missing');
    await c.service.orderConfirmed('missing');
    expect(c.sent).toEqual([]);
  });

  it('a paid online order tells the customer the payment landed AND tells the shop about the new order', async () => {
    const { service, sent } = events();
    await service.paymentConfirmed('order-1');
    expect(sent.map((s) => `${s.to}:${s.type}`).sort()).toEqual(['cust-1:payment_confirmed', 'merch-1:new_order']);
  });

  it('customer-facing events go to the order owner', async () => {
    const { service, sent } = events();
    await service.orderConfirmed('order-1');
    await service.orderRejected('order-1');
    await service.paymentExpired('order-1');
    await service.refundStarted('order-1');
    await service.refundCompleted('order-1');
    await service.driverNearby('order-1');
    expect(sent.map((s) => `${s.to}:${s.type}`)).toEqual([
      'cust-1:order_confirmed',
      'cust-1:order_rejected',
      'cust-1:order_cancelled_unpaid',
      'cust-1:refund_started',
      'cust-1:refund_completed',
      'cust-1:driver_nearby',
    ]);
  });

  it('shop events go to the shop owner; a customer cancel reaches the shop', async () => {
    const { service, sent } = events();
    await service.customerCancelled('order-1');
    await service.driverAccepted(assignment);
    await service.driverPickedUp(assignment);
    expect(sent.map((s) => `${s.to}:${s.type}`)).toEqual(['merch-1:order_cancelled_by_customer', 'merch-1:shop_driver_accepted', 'merch-1:shop_driver_picked_up']);
  });

  it('a delivery offer goes to that driver only (re-offers are new notifications); suspended drivers get nothing', async () => {
    const a = events();
    await a.service.driverOffered(assignment);
    expect(a.sent).toEqual([{ to: 'drv-uid', type: 'new_delivery_offer', ref: 'a-1', orderId: 'order-1' }]);
    const b = events({ driverActive: false });
    await b.service.driverOffered(assignment);
    expect(b.sent).toEqual([]);
  });

  it('refunds due and KYC submissions go to every admin, and to nobody when there are none', async () => {
    const a = events();
    await a.service.refundDue('order-1');
    await a.service.kycSubmitted({ kind: 'driver', driverId: 'drv-1' }, 'v1');
    expect(a.sent.map((s) => `${s.to}:${s.type}`).sort()).toEqual(['admin-1:admin_kyc_submitted', 'admin-1:admin_refund_due', 'admin-2:admin_kyc_submitted', 'admin-2:admin_refund_due']);
    const b = events({ admins: [] });
    await b.service.refundDue('order-1');
    expect(b.sent).toEqual([]);
  });

  it('a KYC decision reaches the person it is about (driver account or shop owner), once per decision', async () => {
    const { service, sent } = events();
    await service.kycDecided({ kind: 'driver', driverId: 'drv-1' }, true, 'v1');
    await service.kycDecided({ kind: 'merchant', shopId: 'duo-shop' }, false, 'v7');
    expect(sent).toEqual([
      { to: 'drv-uid', type: 'kyc_approved', ref: 'driver:drv-1:v1', orderId: undefined },
      { to: 'merch-1', type: 'kyc_rejected', ref: 'merchant:duo-shop:v7', orderId: undefined },
    ]);
  });
});
