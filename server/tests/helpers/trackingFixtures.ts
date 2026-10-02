import type { CustomerAppOrderProvider } from '../../src/integrations/customerApp/CustomerAppOrderProvider';
import type { DeliveryAssignmentStore } from '../../src/integrations/firebase/FirestoreDeliveryAssignmentStore';
import type { DeliveryGeocoder } from '../../src/integrations/geocoding/DeliveryGeocoder';
import { InMemoryLiveDriverLocationStore } from '../../src/integrations/redis/LiveDriverLocationStore';
import { DeliveryAssignmentService } from '../../src/services/deliveryAssignmentService';
import { CustomerTrackingService } from '../../src/services/customerTrackingService';
import { DeliveryEventHub } from '../../src/realtime/deliveryEvents';

export const T0 = new Date('2026-01-01T12:00:00Z').getTime();
export const clock = { now: T0 };

export function order(overrides: Record<string, unknown> = {}) {
  return {
    orderId: 'order-1',
    shopId: 'shop-1',
    customerId: 'customer-A',
    status: 'pending',
    paymentStatus: 'paid',
    paymentId: 'pay_SECRET',
    items: [],
    delivery: { label: 'Home', fullAddress: '123 MG Road', phoneNumber: '+911234567890' },
    pricing: { total: 10 },
    createdAt: new Date(T0),
    ...overrides,
  };
}

export function assignment(id: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    assignmentId: id,
    orderId: 'order-1',
    customerAppShopId: 'shop-1',
    driverId: 'driver-1',
    status,
    assignedAt: new Date(T0),
    createdAt: new Date(T0),
    updatedAt: new Date(T0),
    ...overrides,
  };
}

export function assignmentStore(initial: Record<string, Record<string, unknown>>) {
  const data = new Map(Object.entries(initial));
  const store: DeliveryAssignmentStore & { data: Map<string, Record<string, unknown>> } = {
    data,
    get: async (id) => data.get(id) ?? null,
    listByDriverId: async (d) => [...data.values()].filter((v) => v.driverId === d),
    listByCustomerAppShopId: async (s) => [...data.values()].filter((v) => v.customerAppShopId === s),
    listByOrderId: async (o) => [...data.values()].filter((v) => v.orderId === o),
    createIfNoActiveAssignmentForOrder: async () => {
      throw new Error('unused');
    },
    runTransaction: async (id, updater) => {
      const next = updater(data.get(id) ?? null);
      data.set(id, next);
      return next;
    },
  };
  return store;
}

export interface CustomerFixtureOptions {
  orders?: Record<string, unknown>;
  assignments?: Record<string, Record<string, unknown>>;
  geocoder?: DeliveryGeocoder;
  hub?: DeliveryEventHub;
}

export function buildCustomerFixture(options: CustomerFixtureOptions = {}) {
  const orders = options.orders ?? { 'order-1': order() };
  const orderProvider: CustomerAppOrderProvider & { reads: number; writes: number } = {
    reads: 0,
    writes: 0,
    listOrdersByShopId: async () => [],
    getOrderById: async (id) => {
      orderProvider.reads++;
      return orders[id] ?? null;
    },
    markOrderDelivered: async () => {
      orderProvider.writes++;
      throw new Error('Customer App writes must never be invoked');
    },
  };
  const store = assignmentStore(options.assignments ?? { 'a-1': assignment('a-1', 'accepted') });
  const hub = options.hub ?? new DeliveryEventHub();
  const live = new InMemoryLiveDriverLocationStore(300_000, () => clock.now);
  const assignments = new DeliveryAssignmentService(store, undefined, orderProvider, hub, undefined, undefined, () => new Date(clock.now));
  const geocoder: DeliveryGeocoder = options.geocoder ?? { geocode: async () => ({ latitude: 28.7, longitude: 77.3 }) };
  const service = new CustomerTrackingService(orderProvider, assignments, live, geocoder, () => clock.now);
  return { orderProvider, store, hub, live, assignments, service, geocoder };
}
