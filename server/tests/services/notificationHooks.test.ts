import { createHmac } from 'node:crypto';

import { PAYMENT_HOLD_MINUTES } from '../../src/config/cashfree';
import { gatewayOrderIdFor } from '../../src/integrations/payments/CashfreeGateway';
import { InMemoryLiveDriverLocationStore } from '../../src/integrations/redis/LiveDriverLocationStore';
import { CustomerOrderService } from '../../src/services/customerOrderService';
import { DeliveryLifecycleEffectsService } from '../../src/services/deliveryLifecycleEffects';
import { DriverNearbyService, NEARBY_METERS } from '../../src/services/driverNearby';
import { DriverTrackingService } from '../../src/services/driverTrackingService';
import { OrderStatusService } from '../../src/services/orderStatusService';
import { PaymentService } from '../../src/services/paymentService';
import type { PlaceOrderBody } from '../../src/types/customerOrder';
import { FakeCustomerStore, NOW, seed } from '../helpers/customerFixtures';
import { FakeGateway } from '../helpers/fakePaymentGateway';
import { RecordingEvents } from '../helpers/recordingEvents';

const clock = { t: NOW.getTime() };
const now = () => new Date(clock.t);
const MIN = 60_000;
const BASE = 'https://api.example.com';
const actor = { type: 'merchant' as const, id: 'm-1' };

function setup() {
  clock.t = NOW.getTime();
  const store = new FakeCustomerStore();
  seed(store, 20);
  const gateway = new FakeGateway();
  const events = new RecordingEvents();
  const orders = new CustomerOrderService(store, now, gateway, events);
  const payments = new PaymentService(orders, gateway, BASE, store, now, events);
  const status = new OrderStatusService(store, now, events);
  return { store, gateway, events, orders, payments, status };
}

const body = (over: Partial<PlaceOrderBody> = {}): PlaceOrderBody => ({
  clientRequestId: 'req-00000001',
  shopId: 'shop-1',
  addressId: 'addr-1',
  paymentMethod: 'cod',
  items: [{ productId: 'p-milk', quantity: 2 }],
  ...over,
});

const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => undefined));
afterEach(() => jest.restoreAllMocks());

describe('new order → the shop', () => {
  it('a cash order tells the shop once; a retry of the same checkout does not tell it again', async () => {
    const { orders, events } = setup();
    const { order } = await orders.placeOrder('cust-A', body());
    await orders.placeOrder('cust-A', body()); // double tap / network retry: same order
    expect(events.calls).toEqual([`orderPlaced:${order.orderId}`]);
  });

  it('an online order is NOT announced to the shop until it is paid', async () => {
    const { orders, payments, gateway, events } = setup();
    const { order } = await orders.placeOrder('cust-A', body({ paymentMethod: 'online' }));
    expect(events.calls).toEqual([]);

    await payments.startPayment('cust-A', order.orderId);
    gateway.pay(gatewayOrderIdFor(order.orderId));
    await payments.verify('cust-A', order.orderId);
    await payments.verify('cust-A', order.orderId); // checking again changes nothing
    expect(events.calls).toEqual([`paymentConfirmed:${order.orderId}`]);
  });

  it('a failed checkout (out of stock) tells nobody', async () => {
    const { orders, events } = setup();
    await expect(orders.placeOrder('cust-A', body({ items: [{ productId: 'p-milk', quantity: 99 }] }))).rejects.toBeDefined();
    expect(events.calls).toEqual([]);
  });
});

describe('customer cancels → the shop', () => {
  it('tells the shop when it could already see the order, once', async () => {
    const { orders, events } = setup();
    const { order } = await orders.placeOrder('cust-A', body());
    events.calls = [];
    await orders.cancelOrder('cust-A', order.orderId);
    await orders.cancelOrder('cust-A', order.orderId); // repeat is a no-op
    expect(events.calls).toEqual([`customerCancelled:${order.orderId}`]);
  });

  it('says nothing to the shop when the customer cancels an unpaid online order (it never saw it)', async () => {
    const { orders, events } = setup();
    const { order } = await orders.placeOrder('cust-A', body({ paymentMethod: 'online' }));
    await orders.cancelOrder('cust-A', order.orderId);
    expect(events.calls).toEqual([]);
  });

  it('says nothing when the cancel is refused', async () => {
    const { orders, status, events } = setup();
    const { order } = await orders.placeOrder('cust-A', body());
    await status.transition(order.orderId, 'shop-1', 'confirmed', actor);
    events.calls = [];
    await expect(orders.cancelOrder('cust-A', order.orderId)).rejects.toMatchObject({ statusCode: 409 });
    expect(events.calls).toEqual([]);
  });
});

describe('shop decisions → the customer', () => {
  it('confirm and reject notify the customer once each; other steps and repeats do not', async () => {
    const { orders, status, events } = setup();
    const a = (await orders.placeOrder('cust-A', body({ clientRequestId: 'req-00000001' }))).order.orderId;
    const b = (await orders.placeOrder('cust-A', body({ clientRequestId: 'req-00000002' }))).order.orderId;
    events.calls = [];

    await status.transition(a, 'shop-1', 'confirmed', actor);
    await status.transition(a, 'shop-1', 'confirmed', actor); // repeat
    await status.transition(a, 'shop-1', 'preparing', actor);
    await status.transition(a, 'shop-1', 'ready_for_pickup', actor);
    await status.transition(b, 'shop-1', 'rejected', actor);
    expect(events.calls).toEqual([`orderConfirmed:${a}`, `orderRejected:${b}`]);
  });

  it('rejecting an order the customer already paid for also raises a refund for the admins', async () => {
    const { orders, payments, gateway, status, events } = setup();
    const { order } = await orders.placeOrder('cust-A', body({ paymentMethod: 'online' }));
    await payments.startPayment('cust-A', order.orderId);
    gateway.pay(gatewayOrderIdFor(order.orderId));
    await payments.verify('cust-A', order.orderId);
    events.calls = [];

    await status.transition(order.orderId, 'shop-1', 'rejected', actor);
    expect(events.calls).toEqual([`orderRejected:${order.orderId}`, `refundDue:${order.orderId}`]);
  });

  it('a failed move (not allowed) tells nobody', async () => {
    const { orders, status, events } = setup();
    const { order } = await orders.placeOrder('cust-A', body());
    events.calls = [];
    await expect(status.transition(order.orderId, 'shop-1', 'preparing', actor)).rejects.toMatchObject({ statusCode: 409 });
    expect(events.calls).toEqual([]);
  });
});

describe('payment → everyone concerned', () => {
  it('a payment that arrives after the order was cancelled raises a refund, not a "paid" notification', async () => {
    const { orders, payments, gateway, events } = setup();
    const { order } = await orders.placeOrder('cust-A', body({ paymentMethod: 'online' }));
    await payments.startPayment('cust-A', order.orderId);
    await orders.cancelOrder('cust-A', order.orderId);
    gateway.orders.get(gatewayOrderIdFor(order.orderId))!.status = 'PAID';
    events.calls = [];

    await payments.applyGatewayResult(gatewayOrderIdFor(order.orderId), 5700);
    expect(events.calls).toEqual([`refundDue:${order.orderId}`]);
  });

  it('an unpaid online order that times out tells the customer, once', async () => {
    const { orders, payments, events } = setup();
    const { order } = await orders.placeOrder('cust-A', body({ paymentMethod: 'online' }));
    await payments.startPayment('cust-A', order.orderId);
    clock.t += (PAYMENT_HOLD_MINUTES + 5) * MIN;
    await payments.sweep();
    await payments.sweep();
    expect(events.calls).toEqual([`paymentExpired:${order.orderId}`]);
  });

  it('a webhook-confirmed payment notifies once even if the webhook is delivered twice', async () => {
    const { orders, payments, gateway, events } = setup();
    const { order } = await orders.placeOrder('cust-A', body({ paymentMethod: 'online' }));
    const gid = gatewayOrderIdFor(order.orderId);
    await payments.startPayment('cust-A', order.orderId);
    gateway.pay(gid);
    const raw = JSON.stringify({ type: 'PAYMENT_SUCCESS_WEBHOOK', data: { order: { order_id: gid } } });
    const ts = '1760000000000';
    const sig = createHmac('sha256', 'test-secret').update(ts + raw).digest('base64');
    await payments.handleWebhook(raw, ts, sig);
    await payments.handleWebhook(raw, ts, sig);
    expect(events.calls).toEqual([`paymentConfirmed:${order.orderId}`]);
  });
});

describe('delivery steps → driver and shop', () => {
  it('offering, accepting and picking up tell the right people (the customer messages are unchanged)', async () => {
    const events = new RecordingEvents();
    const notify = jest.fn().mockResolvedValue('sent');
    const effects = new DeliveryLifecycleEffectsService({} as never, { notify } as never, undefined, events);
    const a = { assignmentId: 'a-1', orderId: 'order-1', customerAppShopId: 'shop-1', driverId: 'd-1' } as never;
    await effects.onAssigned(a);
    await effects.onAccepted(a);
    await effects.onPickedUp(a);
    expect(events.calls).toEqual(['driverOffered:a-1', 'driverAccepted:a-1', 'driverPickedUp:a-1']);
    expect(notify.mock.calls.map((c) => c[0])).toEqual(['delivery_assigned', 'delivery_accepted', 'driver_picked_up']);
  });
});

describe('driver nearby → customer', () => {
  const dest = { latitude: 28.6139, longitude: 77.209 };
  /** A point roughly `meters` north of the destination. */
  const at = (meters: number) => ({ latitude: dest.latitude + meters / 111_320, longitude: dest.longitude });

  function nearbySetup(delivery: Record<string, unknown> | null = { latitude: dest.latitude, longitude: dest.longitude, fullAddress: '12 Park Street' }, geocoded: typeof dest | null = null) {
    const t = { now: 1_000_000 };
    const events = new RecordingEvents();
    const orders = { getOrder: async (id: string) => (delivery ? { orderId: id, delivery } : null) } as never;
    const geocoder = { geocode: jest.fn().mockResolvedValue(geocoded) };
    const service = new DriverNearbyService(orders, geocoder, events, () => t.now);
    return { service, events, geocoder, t };
  }

  it('fires once when the driver gets within the radius, never before, never twice', async () => {
    const { service, events, t } = nearbySetup();
    await service.onPosition('order-1', at(2000));
    t.now += 30_000;
    await service.onPosition('order-1', at(NEARBY_METERS + 100));
    expect(events.calls).toEqual([]);
    t.now += 30_000;
    await service.onPosition('order-1', at(NEARBY_METERS - 50));
    t.now += 30_000;
    await service.onPosition('order-1', at(10));
    expect(events.calls).toEqual(['driverNearby:order-1']);
  });

  it('checks at most every 20 seconds per order (no lookup on every GPS ping)', async () => {
    const { service, events, t } = nearbySetup();
    await service.onPosition('order-1', at(2000));
    await service.onPosition('order-1', at(10)); // 0 s later: skipped
    t.now += 5_000;
    await service.onPosition('order-1', at(10)); // 5 s later: skipped
    expect(events.calls).toEqual([]);
    t.now += 20_000;
    await service.onPosition('order-1', at(10));
    expect(events.calls).toEqual(['driverNearby:order-1']);
  });

  it('does not trust a vague GPS fix', async () => {
    const { service, events } = nearbySetup();
    await service.onPosition('order-1', { ...at(10), accuracyMeters: 500 });
    expect(events.calls).toEqual([]);
  });

  it('uses the address GPS point when there is one, otherwise the geocoded address; with neither, stays silent', async () => {
    const saved = nearbySetup();
    await saved.service.onPosition('order-1', at(10));
    expect(saved.geocoder.geocode).not.toHaveBeenCalled();
    expect(saved.events.calls).toHaveLength(1);

    const viaGeocoder = nearbySetup({ fullAddress: '12 Park Street' }, dest);
    await viaGeocoder.service.onPosition('order-1', at(10));
    expect(viaGeocoder.geocoder.geocode).toHaveBeenCalledWith('12 Park Street');
    expect(viaGeocoder.events.calls).toHaveLength(1);

    for (const none of [nearbySetup({ fullAddress: '12 Park Street' }, null), nearbySetup(null), nearbySetup({})]) {
      await none.service.onPosition('order-1', at(10));
      expect(none.events.calls).toEqual([]);
    }
  });

  it('is wired to live tracking: only a driver CARRYING the order (picked up) can trigger it', async () => {
    const calls: string[] = [];
    const nearby = { onPosition: async (orderId: string) => void calls.push(orderId) };
    const build = (status: string) =>
      new DriverTrackingService(
        {
          listByDriverId: async () => [{ assignmentId: 'a-1', orderId: 'order-1', customerAppShopId: 'shop-1', driverId: 'd-1', status, assignedAt: NOW, createdAt: NOW, updatedAt: NOW }],
        } as never,
        new InMemoryLiveDriverLocationStore(5 * MIN, () => NOW.getTime()),
        { updateLocation: async () => undefined } as never,
        () => NOW.getTime(),
        { publish: () => undefined } as never,
        nearby
      );
    await build('accepted').publishLocation('d-1', 'a-1', { latitude: 28.6, longitude: 77.2 });
    expect(calls).toEqual([]);
    await build('picked_up').publishLocation('d-1', 'a-1', { latitude: 28.6, longitude: 77.2 });
    await tick();
    expect(calls).toEqual(['order-1']);
  });
});
