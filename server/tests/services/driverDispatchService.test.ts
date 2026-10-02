import request from 'supertest';

import { app } from '../../src/app';
import { ActiveAssignmentConflictError } from '../../src/integrations/firebase/FirestoreDeliveryAssignmentStore';
import type { DeliveryAssignmentStore } from '../../src/integrations/firebase/FirestoreDeliveryAssignmentStore';
import type { DriverLocationStore } from '../../src/integrations/firebase/FirestoreDriverLocationStore';
import type { DuoFaceDriverStore } from '../../src/integrations/firebase/FirestoreDuoFaceDriverStore';
import { InMemoryLiveDriverLocationStore, LiveLocationUnavailableError } from '../../src/integrations/redis/LiveDriverLocationStore';
import type { LiveDriverLocationStore } from '../../src/integrations/redis/LiveDriverLocationStore';
import { AppError } from '../../src/middleware/errorHandler';
import { DeliveryAssignmentService, OFFER_TTL_MS } from '../../src/services/deliveryAssignmentService';
import type { DispatchTrigger } from '../../src/services/dispatchTrigger';
import { DriverDispatchService } from '../../src/services/driverDispatchService';
import { DuoFaceShopService } from '../../src/services/duoFaceShopService';
import { DriverLocationService } from '../../src/services/driverLocationService';
import { DriverService } from '../../src/services/driverService';
import { haversineMeters, rankByDistance } from '../../src/services/geo';
import { DUTY_LOCATION_STALE_AFTER_MS } from '../../src/services/locationFreshness';
import type { DuoFaceShop } from '../../src/types/duoFaceShop';

// Shop pickup point (Connaught Place, Delhi). Driver offsets in degrees of latitude (~111 km each).
const PICKUP = { latitude: 28.6315, longitude: 77.2167 };
const at = (northDegrees: number) => ({ latitude: PICKUP.latitude + northDegrees, longitude: PICKUP.longitude });

const T0 = new Date('2026-06-01T10:00:00Z');

function fakeAssignmentStore() {
  const data = new Map<string, Record<string, unknown>>();
  const store: DeliveryAssignmentStore & { data: typeof data } = {
    data,
    get: async (id) => data.get(id) ?? null,
    listByDriverId: async (d) => [...data.values()].filter((v) => v.driverId === d),
    listByCustomerAppShopId: async (s) => [...data.values()].filter((v) => v.customerAppShopId === s),
    listByOrderId: async (o) => [...data.values()].filter((v) => v.orderId === o),
    createIfNoActiveAssignmentForOrder: async (id, orderId, active, doc) => {
      if ([...data.values()].some((v) => v.orderId === orderId && active.includes(v.status as string))) {
        throw new ActiveAssignmentConflictError('active');
      }
      data.set(id, doc);
    },
    runTransaction: async (id, updater) => {
      const next = updater(data.get(id) ?? null);
      data.set(id, next);
      return next;
    },
  };
  return store;
}

interface DriverSetup {
  id: string;
  status?: string;
  /** Defaults to true: dispatch only offers orders to on-duty drivers. */
  onDuty?: boolean;
  /** Latest manual (Firestore) fix. */
  manual?: { latitude: number; longitude: number; ageMs?: number };
  /** Live (Redis) fix. */
  live?: { latitude: number; longitude: number; ageMs?: number };
}

function build(
  drivers: DriverSetup[],
  options: {
    geocode?: () => Promise<{ latitude: number; longitude: number } | null>;
    liveStore?: LiveDriverLocationStore;
    /** Stored Duo-Face shop pickupLocation (linked to customerAppShopId shop-1). */
    storedPickup?: { latitude: number; longitude: number };
  } = {}
) {
  const clock = { now: T0.getTime() };
  const now = () => new Date(clock.now);

  const driverDocs = new Map(
    drivers.map((d) => [
      d.id,
      { driverId: d.id, firebaseUid: `uid-${d.id}`, name: d.id, status: d.status ?? 'active', onDuty: d.onDuty ?? true, createdAt: T0, updatedAt: T0 },
    ])
  );
  const driverStore: DuoFaceDriverStore = {
    get: async (id) => driverDocs.get(id) ?? null,
    set: async () => {},
    listByStatus: async (s) => [...driverDocs.values()].filter((d) => d.status === s),
    findByFirebaseUid: async () => null,
  };

  const locationDocs = new Map<string, Record<string, unknown>>();
  const live = options.liveStore ?? new InMemoryLiveDriverLocationStore(300_000, () => clock.now);
  for (const d of drivers) {
    if (d.manual) {
      locationDocs.set(d.id, {
        driverId: d.id,
        latitude: d.manual.latitude,
        longitude: d.manual.longitude,
        capturedAt: new Date(clock.now - (d.manual.ageMs ?? 0)),
        updatedAt: T0,
      });
    }
    if (d.live) {
      void live.update({ driverId: d.id, assignmentId: 'a', latitude: d.live.latitude, longitude: d.live.longitude, capturedAt: new Date(clock.now - (d.live.ageMs ?? 0)) });
    }
  }
  const locationStore: DriverLocationStore = {
    get: async (id) => locationDocs.get(id) ?? null,
    set: async () => {},
  };

  const store = fakeAssignmentStore();
  const orders: Record<string, unknown> = {
    'order-1': {
      orderId: 'order-1',
      shopId: 'shop-1',
      status: 'pending',
      paymentStatus: 'paid',
      items: [{ productId: 'p', name: 'Milk', price: 28, quantity: 1, subtotal: 28 }],
      delivery: { label: 'Home', fullAddress: '1 Road', phoneNumber: '+911234567890' },
      pricing: { total: 28 },
      createdAt: T0,
    },
    'order-other': { ...({} as object), orderId: 'order-other', shopId: 'shop-2', status: 'pending', paymentStatus: 'paid', items: [{ productId: 'p', name: 'Milk', price: 28, quantity: 1, subtotal: 28 }], delivery: { label: 'Home', fullAddress: '1 Road', phoneNumber: '+911234567890' }, pricing: { total: 28 }, createdAt: T0 },
  };
  const orderProvider = {
    listOrdersByShopId: async () => [],
    getOrderById: async (id: string) => orders[id] ?? null,
    markOrderDelivered: async () => {
      throw new Error('unused');
    },
  };

  const trigger: { current: DispatchTrigger } = { current: { redispatch: async () => {} } };
  const driverService = new DriverService(driverStore);
  const assignments = new DeliveryAssignmentService(
    store,
    driverService,
    orderProvider,
    undefined,
    { onAssigned: async () => {}, onAccepted: async () => {}, onPickedUp: async () => {}, onDelivered: async () => {} },
    { redispatch: (o, s) => trigger.current.redispatch(o, s) },
    now
  );
  const shopDoc = {
    shopId: 'duo-shop-1',
    name: 'Shop',
    status: 'active',
    merchantFirebaseUid: 'm',
    customerAppShopId: 'shop-1',
    ...(options.storedPickup ? { pickupLocation: options.storedPickup } : {}),
    createdAt: T0,
    updatedAt: T0,
  };
  const shopService = new DuoFaceShopService({
    get: async () => shopDoc,
    set: async () => {},
    findByMerchantFirebaseUid: async () => shopDoc,
    findByCustomerAppShopId: async (id) => (id === 'shop-1' ? shopDoc : null),
  });
  const geocodeSpy = jest.fn(options.geocode ?? (async () => PICKUP));
  const dispatch = new DriverDispatchService(
    assignments,
    store,
    driverService,
    new DriverLocationService(locationStore),
    live,
    { getShop: async () => ({ name: 'Shop', address: '1 Connaught Place, Delhi' }) },
    { geocode: geocodeSpy },
    orderProvider,
    now,
    shopService
  );
  trigger.current = dispatch;

  const shop = { shopId: 'duo-shop-1', name: 'Shop', status: 'active', merchantFirebaseUid: 'm', customerAppShopId: 'shop-1', createdAt: T0, updatedAt: T0 } as DuoFaceShop;
  return { dispatch, assignments, store, shop, clock, geocodeSpy };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('geo', () => {
  it('computes great-circle distance (1 degree of latitude is ~111 km)', () => {
    expect(haversineMeters(PICKUP, at(1))).toBeGreaterThan(110_000);
    expect(haversineMeters(PICKUP, at(1))).toBeLessThan(112_000);
    expect(haversineMeters(PICKUP, PICKUP)).toBe(0);
  });

  it('ranks nearest first and breaks exact ties by driverId', () => {
    const ranked = rankByDistance(PICKUP, [
      { driverId: 'c', location: at(0.03) },
      { driverId: 'b', location: at(0.01) },
      { driverId: 'a', location: at(0.01) },
    ]);
    expect(ranked.map((r) => r.driverId)).toEqual(['a', 'b', 'c']);
  });
});

describe('DriverDispatchService.requestDriver', () => {
  it('assigns the nearest eligible driver', async () => {
    const { dispatch, shop } = build([
      { id: 'far', manual: at(0.05) },
      { id: 'near', manual: at(0.005) },
      { id: 'mid', manual: at(0.02) },
    ]);
    const assignment = await dispatch.requestDriver(shop, 'order-1');
    expect(assignment).toMatchObject({ driverId: 'near', status: 'assigned', orderId: 'order-1', customerAppShopId: 'shop-1' });
  });

  it('prefers a fresh live (Redis) fix over an older manual one', async () => {
    const { dispatch, shop } = build([
      { id: 'moved-close', manual: at(0.2), live: at(0.001) },
      { id: 'other', manual: at(0.01) },
    ]);
    expect((await dispatch.requestDriver(shop, 'order-1')).driverId).toBe('moved-close');
  });

  it('falls back to the manual fix when Redis is unavailable', async () => {
    const broken: LiveDriverLocationStore = {
      update: async () => {},
      get: async () => {
        throw new LiveLocationUnavailableError();
      },
      has: async () => false,
      remove: async () => {},
    };
    const { dispatch, shop } = build([{ id: 'd1', manual: at(0.01) }], { liveStore: broken });
    expect((await dispatch.requestDriver(shop, 'order-1')).driverId).toBe('d1');
  });

  it('skips drivers whose location is stale, missing or who are not active', async () => {
    const { dispatch, shop } = build([
      { id: 'stale', manual: { ...at(0.001), ageMs: DUTY_LOCATION_STALE_AFTER_MS + 1000 } },
      { id: 'no-location' },
      { id: 'suspended', status: 'suspended', manual: at(0.002) },
      { id: 'ok', manual: at(0.05) },
    ]);
    expect((await dispatch.requestDriver(shop, 'order-1')).driverId).toBe('ok');
  });

  it('skips a driver who is already on an active delivery (including a pending offer)', async () => {
    const { dispatch, store, shop } = build([
      { id: 'busy', manual: at(0.001) },
      { id: 'free', manual: at(0.05) },
    ]);
    store.data.set('x', { assignmentId: 'x', orderId: 'order-9', customerAppShopId: 'shop-1', driverId: 'busy', status: 'picked_up', assignedAt: T0, createdAt: T0, updatedAt: T0 });
    expect((await dispatch.requestDriver(shop, 'order-1')).driverId).toBe('free');
  });

  it('409 "No driver available" when nobody is eligible, and creates nothing', async () => {
    const { dispatch, store, shop } = build([{ id: 'stale', manual: { ...at(0.001), ageMs: DUTY_LOCATION_STALE_AFTER_MS + 1 } }]);
    await expect(dispatch.requestDriver(shop, 'order-1')).rejects.toMatchObject({ statusCode: 409, message: 'No driver available nearby right now.' });
    expect(store.data.size).toBe(0);
  });

  it('409 "Shop location unavailable" when the shop address cannot be geocoded (never guesses)', async () => {
    const { dispatch, shop } = build([{ id: 'd1', manual: at(0.001) }], { geocode: async () => null });
    await expect(dispatch.requestDriver(shop, 'order-1')).rejects.toMatchObject({ statusCode: 409, message: 'Shop location unavailable.' });
  });

  it('404 for an order of another shop, or a missing one', async () => {
    const { dispatch, shop } = build([{ id: 'd1', manual: at(0.001) }]);
    await expect(dispatch.requestDriver(shop, 'order-other')).rejects.toMatchObject({ statusCode: 404 });
    await expect(dispatch.requestDriver(shop, 'nope')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('409 when the shop is not linked to a Customer App shop', async () => {
    const { dispatch, shop } = build([{ id: 'd1', manual: at(0.001) }]);
    await expect(dispatch.requestDriver({ ...shop, customerAppShopId: undefined }, 'order-1')).rejects.toBeInstanceOf(AppError);
  });

  it('a second request for an already-assigned order is a 409 and does not double-assign', async () => {
    const { dispatch, store, shop } = build([
      { id: 'a', manual: at(0.001) },
      { id: 'b', manual: at(0.002) },
    ]);
    await dispatch.requestDriver(shop, 'order-1');
    await expect(dispatch.requestDriver(shop, 'order-1')).rejects.toMatchObject({ statusCode: 409 });
    expect([...store.data.values()].filter((a) => a.status === 'assigned')).toHaveLength(1);
  });
});

describe('pickup point resolution', () => {
  it('uses the stored shop pickupLocation and never geocodes', async () => {
    const { dispatch, shop, geocodeSpy } = build([{ id: 'near', manual: at(0.001) }], { storedPickup: PICKUP });
    expect((await dispatch.requestDriver(shop, 'order-1')).driverId).toBe('near');
    expect(geocodeSpy).not.toHaveBeenCalled();
  });

  it('the stored location, not the geocoded address, decides who is nearest', async () => {
    // Geocoding would put the shop at PICKUP (so "north" would win); the stored point is 0.1 deg south, next to "south".
    const south = at(-0.1);
    const { dispatch, shop } = build(
      [
        { id: 'north', manual: at(0.001) },
        { id: 'south', manual: south },
      ],
      { storedPickup: south }
    );
    expect((await dispatch.requestDriver(shop, 'order-1')).driverId).toBe('south');
  });

  it('falls back to geocoding the address when no location is stored', async () => {
    const { dispatch, shop, geocodeSpy } = build([{ id: 'd1', manual: at(0.001) }]);
    await dispatch.requestDriver(shop, 'order-1');
    expect(geocodeSpy).toHaveBeenCalledTimes(1);
  });

  it('a re-offer after a rejection also uses the stored point', async () => {
    const { dispatch, assignments, store, shop, geocodeSpy } = build(
      [
        { id: 'a', manual: at(0.001) },
        { id: 'b', manual: at(0.01) },
      ],
      { storedPickup: PICKUP }
    );
    const first = await dispatch.requestDriver(shop, 'order-1');
    await assignments.rejectAssignment(first.assignmentId, first.driverId);
    await flush();
    expect([...store.data.values()].filter((x) => x.status === 'assigned').map((x) => x.driverId)).toEqual(['b']);
    expect(geocodeSpy).not.toHaveBeenCalled();
  });
});

describe('duty', () => {
  it('never offers an order to an off-duty driver, however close', async () => {
    const { dispatch, shop } = build([
      { id: 'off', onDuty: false, manual: at(0.0001) },
      { id: 'on', manual: at(0.05) },
    ]);
    expect((await dispatch.requestDriver(shop, 'order-1')).driverId).toBe('on');
  });

  it('no on-duty driver means no assignment', async () => {
    const { dispatch, shop } = build([{ id: 'off', onDuty: false, manual: at(0.001) }]);
    await expect(dispatch.requestDriver(shop, 'order-1')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('an on-duty driver whose last fix is 8 minutes old is still eligible; 11 minutes is not', async () => {
    const eight = build([{ id: 'quiet', manual: { ...at(0.001), ageMs: 8 * 60 * 1000 } }]);
    expect((await eight.dispatch.requestDriver(eight.shop, 'order-1')).driverId).toBe('quiet');
    const eleven = build([{ id: 'gone', manual: { ...at(0.001), ageMs: 11 * 60 * 1000 } }]);
    await expect(eleven.dispatch.requestDriver(eleven.shop, 'order-1')).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('stale offers', () => {
  it('a driver whose only pending offer has expired is free to take another order', async () => {
    const { dispatch, store, shop, clock } = build([{ id: 'free-again', manual: at(0.001) }]);
    store.data.set('old', { assignmentId: 'old', orderId: 'order-9', customerAppShopId: 'shop-1', driverId: 'free-again', status: 'assigned', assignedAt: new Date(clock.now - OFFER_TTL_MS - 1000), createdAt: T0, updatedAt: T0 });
    expect((await dispatch.requestDriver(shop, 'order-1')).driverId).toBe('free-again');
  });
});

describe('re-offer on rejection and expiry', () => {
  it('a rejection offers the order to the next-nearest driver, never the one who rejected', async () => {
    const { dispatch, assignments, store, shop } = build([
      { id: 'first', manual: at(0.001) },
      { id: 'second', manual: at(0.01) },
      { id: 'third', manual: at(0.02) },
    ]);
    const first = await dispatch.requestDriver(shop, 'order-1');
    expect(first.driverId).toBe('first');

    await assignments.rejectAssignment(first.assignmentId, 'first');
    await flush();
    const active = [...store.data.values()].filter((a) => a.status === 'assigned');
    expect(active.map((a) => a.driverId)).toEqual(['second']);

    await assignments.rejectAssignment(String(active[0].assignmentId), 'second');
    await flush();
    expect([...store.data.values()].filter((a) => a.status === 'assigned').map((a) => a.driverId)).toEqual(['third']);
  });

  it('when everyone has rejected, the order is left with no active assignment', async () => {
    const { dispatch, assignments, store, shop } = build([{ id: 'only', manual: at(0.001) }]);
    const first = await dispatch.requestDriver(shop, 'order-1');
    await assignments.rejectAssignment(first.assignmentId, 'only');
    await flush();
    expect([...store.data.values()].filter((a) => a.status === 'assigned')).toHaveLength(0);
    // ...and the merchant can request again later once someone is eligible; the rejecter stays excluded.
    await expect(dispatch.requestDriver(shop, 'order-1')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('an unanswered offer expires and is re-offered to the next-nearest driver', async () => {
    const { dispatch, assignments, store, shop, clock } = build([
      { id: 'asleep', manual: at(0.001) },
      { id: 'awake', manual: at(0.01) },
    ]);
    const first = await dispatch.requestDriver(shop, 'order-1');
    clock.now += OFFER_TTL_MS + 1000;
    // keep both fixes fresh enough: manual fixes are 2 min old, well inside 5 min.
    await assignments.sweepExpiredOffers(shop);
    await flush();

    expect(store.data.get(first.assignmentId)).toMatchObject({ status: 'cancelled' });
    expect([...store.data.values()].filter((a) => a.status === 'assigned').map((a) => a.driverId)).toEqual(['awake']);
  });

  it('a fresh offer is not expired by the sweep', async () => {
    const { dispatch, assignments, store, shop, clock } = build([{ id: 'd1', manual: at(0.001) }]);
    const first = await dispatch.requestDriver(shop, 'order-1');
    clock.now += OFFER_TTL_MS - 1000;
    await assignments.sweepExpiredOffers(shop);
    expect(store.data.get(first.assignmentId)).toMatchObject({ status: 'assigned' });
  });

  it('a driver cannot accept an offer that has already timed out', async () => {
    const { dispatch, assignments, shop, clock } = build([{ id: 'd1', manual: at(0.001) }]);
    const first = await dispatch.requestDriver(shop, 'order-1');
    clock.now += OFFER_TTL_MS + 1000;
    await expect(assignments.acceptAssignment(first.assignmentId, 'd1')).rejects.toMatchObject({ statusCode: 409, message: 'This offer expired.' });
  });

  it('an accepted assignment is never expired', async () => {
    const { dispatch, assignments, store, shop, clock } = build([{ id: 'd1', manual: at(0.001) }]);
    const first = await dispatch.requestDriver(shop, 'order-1');
    await assignments.acceptAssignment(first.assignmentId, 'd1');
    clock.now += OFFER_TTL_MS * 10;
    await assignments.sweepExpiredOffers(shop);
    expect(store.data.get(first.assignmentId)).toMatchObject({ status: 'accepted' });
  });
});

describe('the app has no driver-picking endpoint', () => {
  it('GET /merchant/drivers is gone', async () => {
    const response = await request(app).get('/merchant/drivers');
    expect(response.status).toBe(404);
  });
});
