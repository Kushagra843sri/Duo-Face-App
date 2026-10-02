import { createServer } from 'http';
import type { AddressInfo } from 'net';

import { io as connect } from 'socket.io-client';
import type { Socket as ClientSocket } from 'socket.io-client';

import type { FirebaseIdentityVerifier } from '../../src/integrations/firebase/FirebaseAuthService';
import { attachCustomerTrackingGateway, deliveryRoom, GATEWAY_LIMITS } from '../../src/realtime/customerTrackingGateway';
import { DriverTrackingService } from '../../src/services/driverTrackingService';
import { DriverLocationService } from '../../src/services/driverLocationService';
import { LiveLocationUnavailableError } from '../../src/integrations/redis/LiveDriverLocationStore';
import type { LiveDriverLocationStore } from '../../src/integrations/redis/LiveDriverLocationStore';
import { CustomerTrackingService } from '../../src/services/customerTrackingService';
import { assignment, buildCustomerFixture, clock, order, T0 } from '../helpers/trackingFixtures';
import type { CustomerFixtureOptions } from '../helpers/trackingFixtures';

const tokens: Record<string, string> = { 'token-A': 'customer-A', 'token-B': 'customer-B' };
const verifier: FirebaseIdentityVerifier = {
  verifyIdToken: async (token) => {
    const firebaseUid = tokens[token];
    if (!firebaseUid) throw new Error('bad token');
    return { firebaseUid };
  },
};

type AckResult = { ok: boolean; error?: string };

const open: ClientSocket[] = [];
let close: (() => Promise<void>) | undefined;

async function start(options: CustomerFixtureOptions = {}, live?: LiveDriverLocationStore) {
  const fixture = buildCustomerFixture(options);
  const service = live
    ? new CustomerTrackingService(fixture.orderProvider, fixture.assignments, live, fixture.geocoder, () => clock.now)
    : fixture.service;
  const httpServer = createServer();
  const gateway = attachCustomerTrackingGateway(httpServer, {
    verifier,
    trackingService: service,
    hub: fixture.hub,
    redisUrl: null,
    now: () => clock.now,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  close = async () => {
    await gateway.close();
    httpServer.close();
  };
  return { ...fixture, gateway, url: `http://127.0.0.1:${port}` };
}

function client(url: string, token?: string): ClientSocket {
  const socket = connect(url, { transports: ['websocket'], auth: token ? { token } : {}, reconnection: false, forceNew: true });
  open.push(socket);
  return socket;
}

const connected = (socket: ClientSocket) => new Promise<void>((resolve, reject) => {
  socket.once('connect', () => resolve());
  socket.once('connect_error', (error) => reject(error));
});

const subscribe = (socket: ClientSocket, orderId: string) =>
  new Promise<AckResult>((resolve) => socket.emit('subscribe', { orderId }, resolve));

/** Collects every 'tracking' event on a socket. */
function collect(socket: ClientSocket) {
  const events: Array<Record<string, unknown>> = [];
  socket.on('tracking', (event) => events.push(event));
  return events;
}

const waitFor = async (predicate: () => boolean, timeoutMs = 2000) => {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

beforeEach(() => {
  clock.now = T0;
});

afterEach(async () => {
  open.splice(0).forEach((s) => s.disconnect());
  await close?.();
  close = undefined;
});

describe('WebSocket authentication', () => {
  it('rejects a connection without a token', async () => {
    const { url } = await start();
    await expect(connected(client(url))).rejects.toThrow('unauthorized');
  });

  it('rejects an invalid token without leaking verifier details', async () => {
    const { url } = await start();
    await expect(connected(client(url, 'garbage'))).rejects.toThrow(/^unauthorized$/);
  });

  it('accepts a valid token', async () => {
    const { url } = await start();
    await expect(connected(client(url, 'token-A'))).resolves.toBeUndefined();
  });

  it('does not accept a token from the URL query string', async () => {
    const { url } = await start();
    const socket = connect(url, { transports: ['websocket'], query: { token: 'token-A' }, reconnection: false, forceNew: true });
    open.push(socket);
    await expect(connected(socket)).rejects.toThrow('unauthorized');
  });
});

describe('subscription authorization', () => {
  it('a customer subscribing to their own accepted order gets an immediate snapshot with the current location', async () => {
    const f = await start();
    await f.live.update({ driverId: 'driver-1', assignmentId: 'a-1', latitude: 28.6, longitude: 77.2, capturedAt: new Date(clock.now) });
    const socket = client(f.url, 'token-A');
    const events = collect(socket);
    await connected(socket);

    expect(await subscribe(socket, 'order-1')).toEqual({ ok: true });
    await waitFor(() => events.length >= 1);
    expect(events[0]).toMatchObject({
      type: 'snapshot',
      tracking: { available: true, status: 'accepted', location: { latitude: 28.6, longitude: 77.2, fresh: true } },
    });
  });

  it('snapshot says unavailable (no manufactured location) when Redis has none', async () => {
    const f = await start();
    const socket = client(f.url, 'token-A');
    const events = collect(socket);
    await connected(socket);
    await subscribe(socket, 'order-1');
    await waitFor(() => events.length >= 1);
    expect((events[0].tracking as { available: boolean; location?: unknown }).available).toBe(false);
    expect((events[0].tracking as { location?: unknown }).location).toBeUndefined();
  });

  it("rejects another customer's order as not_found, joins no room, and sends nothing", async () => {
    const f = await start();
    const socket = client(f.url, 'token-B');
    const events = collect(socket);
    await connected(socket);

    expect(await subscribe(socket, 'order-1')).toEqual({ ok: false, error: 'not_found' });
    expect(await subscribe(socket, 'no-such-order')).toEqual({ ok: false, error: 'not_found' });
    f.hub.publish('order-1', { type: 'driver_location', location: { latitude: 1, longitude: 2, capturedAt: 'x' } });
    await settle();
    expect(events).toEqual([]);
    expect(f.gateway.io.sockets.adapter.rooms.get(deliveryRoom('order-1'))).toBeUndefined();
  });

  it('rejects malformed subscribe payloads, including attempts to name a driver/room', async () => {
    const f = await start();
    const socket = client(f.url, 'token-A');
    await connected(socket);
    for (const payload of [{}, { orderId: '' }, { orderId: 'order-1', driverId: 'driver-1' }, { room: 'driver:driver-1' }, 'order-1']) {
      const result = await new Promise<AckResult>((resolve) => socket.emit('subscribe', payload, resolve));
      expect(result).toEqual({ ok: false, error: 'invalid' });
    }
  });

  it('for an assigned order: snapshot unavailable but the customer stays subscribed for later events', async () => {
    const f = await start({ assignments: { 'a-1': assignment('a-1', 'assigned') } });
    await f.live.update({ driverId: 'driver-1', assignmentId: 'a-1', latitude: 28.6, longitude: 77.2, capturedAt: new Date(clock.now) });
    const socket = client(f.url, 'token-A');
    const events = collect(socket);
    await connected(socket);
    await subscribe(socket, 'order-1');
    await waitFor(() => events.length >= 1);

    expect(events[0]).toMatchObject({ type: 'snapshot', tracking: { available: false, status: 'assigned' } });
    expect(JSON.stringify(events[0])).not.toContain('28.6');
    expect(f.gateway.io.sockets.adapter.rooms.get(deliveryRoom('order-1'))?.size).toBe(1);
  });

  it('for a delivered order: snapshot + tracking_ended, and no subscription is kept', async () => {
    const f = await start({ assignments: { 'a-1': assignment('a-1', 'delivered') } });
    const socket = client(f.url, 'token-A');
    const events = collect(socket);
    await connected(socket);
    await subscribe(socket, 'order-1');
    await waitFor(() => events.length >= 2);
    expect(events.map((e) => e.type)).toEqual(['snapshot', 'tracking_ended']);
    expect(f.gateway.io.sockets.adapter.rooms.get(deliveryRoom('order-1'))).toBeUndefined();
  });

  it('when Redis is down the subscription still succeeds with an unavailable snapshot', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const down: LiveDriverLocationStore = {
      update: async () => { throw new LiveLocationUnavailableError(); },
      get: async () => { throw new LiveLocationUnavailableError(); },
      has: async () => { throw new LiveLocationUnavailableError(); },
      remove: async () => { throw new LiveLocationUnavailableError(); },
    };
    const f = await start({}, down);
    const socket = client(f.url, 'token-A');
    const events = collect(socket);
    await connected(socket);
    expect(await subscribe(socket, 'order-1')).toEqual({ ok: true });
    await waitFor(() => events.length >= 1);
    warn.mockRestore();
    expect(events[0]).toMatchObject({ type: 'snapshot', tracking: { available: false } });
  });
});

describe('realtime events', () => {
  it('a subscribed customer receives only their own order\'s events, with only the documented payload', async () => {
    const f = await start({
      orders: { 'order-1': order(), 'order-2': order({ orderId: 'order-2', customerId: 'customer-B' }) },
      assignments: {
        'a-1': assignment('a-1', 'accepted'),
        'a-2': assignment('a-2', 'accepted', { orderId: 'order-2', driverId: 'driver-2' }),
      },
    });
    const a = client(f.url, 'token-A');
    const b = client(f.url, 'token-B');
    const eventsA = collect(a);
    const eventsB = collect(b);
    await Promise.all([connected(a), connected(b)]);
    await subscribe(a, 'order-1');
    await subscribe(b, 'order-2');
    await waitFor(() => eventsA.length >= 1 && eventsB.length >= 1);

    f.hub.publish('order-1', { type: 'driver_location', location: { latitude: 28.61, longitude: 77.21, capturedAt: 'T1' } });
    await waitFor(() => eventsA.length >= 2);
    await settle();

    expect(eventsA[1]).toEqual({ type: 'driver_location', location: { latitude: 28.61, longitude: 77.21, capturedAt: 'T1' } });
    expect(eventsB).toHaveLength(1); // only its own snapshot: no leakage from order-1
  });

  it('end to end: a driver ping through DriverTrackingService reaches the customer as lat/lng/capturedAt only', async () => {
    const f = await start();
    const driverTracking = new DriverTrackingService(f.assignments, f.live, new DriverLocationService({ get: async () => null, set: async () => {} }), () => clock.now, f.hub);
    const socket = client(f.url, 'token-A');
    const events = collect(socket);
    await connected(socket);
    await subscribe(socket, 'order-1');
    await waitFor(() => events.length >= 1);

    await driverTracking.publishLocation('driver-1', 'a-1', {
      latitude: 28.6139,
      longitude: 77.209,
      accuracyMeters: 9,
      heading: 10,
      speedMps: 3,
    });
    await waitFor(() => events.length >= 2);

    expect(events[1]).toEqual({
      type: 'driver_location',
      location: { latitude: 28.6139, longitude: 77.209, capturedAt: new Date(T0).toISOString() },
    });
    const text = JSON.stringify(events[1]);
    for (const banned of ['driver-1', 'a-1', 'accuracy', 'heading', 'speed', 'customer-A', 'MG Road', '+91']) {
      expect(text).not.toContain(banned);
    }
  });

  it('assignment transitions reach the customer as customer-safe lifecycle events; delivery ends tracking', async () => {
    const f = await start({ assignments: { 'a-1': assignment('a-1', 'assigned') } });
    const socket = client(f.url, 'token-A');
    const events = collect(socket);
    await connected(socket);
    await subscribe(socket, 'order-1');
    await waitFor(() => events.length >= 1);

    await f.assignments.acceptAssignment('a-1', 'driver-1');
    await f.assignments.markPickedUp('a-1', 'driver-1');
    await f.assignments.markDelivered('a-1', 'driver-1');
    await waitFor(() => events.some((e) => e.type === 'tracking_ended'));

    expect(events.slice(1)).toEqual([
      { type: 'delivery_status', status: 'accepted' },
      { type: 'delivery_status', status: 'picked_up' },
      { type: 'delivery_status', status: 'delivered' },
      { type: 'tracking_ended' },
    ]);
    // subscription disabled: later location events are not delivered
    f.hub.publish('order-1', { type: 'driver_location', location: { latitude: 1, longitude: 2, capturedAt: 'x' } });
    await settle();
    expect(events).toHaveLength(5);
    expect(f.gateway.io.sockets.adapter.rooms.get(deliveryRoom('order-1'))).toBeUndefined();
    expect(f.orderProvider.writes).toBe(0);
  });

  it('a rejection is shown to the customer as pending (never "rejected")', async () => {
    const f = await start({ assignments: { 'a-1': assignment('a-1', 'assigned') } });
    const socket = client(f.url, 'token-A');
    const events = collect(socket);
    await connected(socket);
    await subscribe(socket, 'order-1');
    await waitFor(() => events.length >= 1);
    await f.assignments.rejectAssignment('a-1', 'driver-1');
    await waitFor(() => events.length >= 2);
    expect(events[1]).toEqual({ type: 'delivery_status', status: 'pending' });
  });
});

describe('disconnect and cleanup', () => {
  it('removes the subscription on disconnect without touching the assignment, tracking or the order', async () => {
    const f = await start();
    await f.live.update({ driverId: 'driver-1', assignmentId: 'a-1', latitude: 1, longitude: 2, capturedAt: new Date(clock.now) });
    const before = JSON.stringify([...f.store.data.entries()]);
    const socket = client(f.url, 'token-A');
    await connected(socket);
    await subscribe(socket, 'order-1');
    expect(f.gateway.io.sockets.adapter.rooms.get(deliveryRoom('order-1'))?.size).toBe(1);

    socket.disconnect();
    await waitFor(() => f.gateway.io.sockets.adapter.rooms.get(deliveryRoom('order-1')) === undefined);

    expect(JSON.stringify([...f.store.data.entries()])).toBe(before);
    expect(await f.live.has('driver-1')).toBe(true); // driver GPS collection unaffected
    expect(f.orderProvider.writes).toBe(0);
  });

  it('unsubscribe leaves the room', async () => {
    const f = await start();
    const socket = client(f.url, 'token-A');
    await connected(socket);
    await subscribe(socket, 'order-1');
    await new Promise((resolve) => socket.emit('unsubscribe', { orderId: 'order-1' }, resolve));
    expect(f.gateway.io.sockets.adapter.rooms.get(deliveryRoom('order-1'))).toBeUndefined();
  });
});

describe('abuse protection', () => {
  it('limits subscribe attempts per customer (order probing)', async () => {
    const f = await start();
    const socket = client(f.url, 'token-A');
    await connected(socket);
    let last: AckResult = { ok: true };
    for (let i = 0; i < GATEWAY_LIMITS.subscribeAttemptsPerUidPerMinute + 1; i++) {
      last = await subscribe(socket, `probe-${i}`);
    }
    expect(last).toEqual({ ok: false, error: 'rate_limited' });
  });

  it('limits concurrent connections per customer', async () => {
    const f = await start();
    const sockets = Array.from({ length: GATEWAY_LIMITS.maxConcurrentSocketsPerUid }, () => client(f.url, 'token-A'));
    await Promise.all(sockets.map(connected));
    await expect(connected(client(f.url, 'token-A'))).rejects.toThrow('rate_limited');
    // another customer is unaffected
    await expect(connected(client(f.url, 'token-B'))).resolves.toBeUndefined();
  });

  it('caps rooms per socket', async () => {
    const orders: Record<string, unknown> = {};
    const assignments: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i <= GATEWAY_LIMITS.maxRoomsPerSocket; i++) {
      orders[`o-${i}`] = order({ orderId: `o-${i}` });
      assignments[`as-${i}`] = assignment(`as-${i}`, 'accepted', { orderId: `o-${i}` });
    }
    const f = await start({ orders, assignments });
    const socket = client(f.url, 'token-A');
    await connected(socket);
    for (let i = 0; i < GATEWAY_LIMITS.maxRoomsPerSocket; i++) expect((await subscribe(socket, `o-${i}`)).ok).toBe(true);
    expect(await subscribe(socket, `o-${GATEWAY_LIMITS.maxRoomsPerSocket}`)).toEqual({ ok: false, error: 'too_many' });
  });
});
