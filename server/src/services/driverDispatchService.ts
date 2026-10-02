import { FirestoreCustomerAppOrderProvider } from '../integrations/customerApp/FirestoreCustomerAppOrderProvider';
import type { CustomerAppOrderProvider } from '../integrations/customerApp/CustomerAppOrderProvider';
import { FirestoreCustomerAppShopProvider } from '../integrations/customerApp/FirestoreCustomerAppShopProvider';
import type { CustomerAppShopProvider } from '../integrations/customerApp/CustomerAppShopProvider';
import { FirestoreDeliveryAssignmentStore } from '../integrations/firebase/FirestoreDeliveryAssignmentStore';
import type { DeliveryAssignmentStore } from '../integrations/firebase/FirestoreDeliveryAssignmentStore';
import { createDeliveryGeocoder } from '../integrations/geocoding/createDeliveryGeocoder';
import type { DeliveryGeocoder } from '../integrations/geocoding/DeliveryGeocoder';
import { createLiveDriverLocationStore } from '../integrations/redis/createLiveDriverLocationStore';
import type { LiveDriverLocationStore } from '../integrations/redis/LiveDriverLocationStore';
import { AppError } from '../middleware/errorHandler';
import { customerAppOrderSnapshotSchema } from '../types/customerAppOrder';
import { deliveryAssignmentSchema } from '../types/deliveryAssignment';
import type { DeliveryAssignment } from '../types/deliveryAssignment';
import type { DuoFaceShop } from '../types/duoFaceShop';
import { ACTIVE_ASSIGNMENT_STATUSES, DeliveryAssignmentService } from './deliveryAssignmentService';
import { DuoFaceShopService } from './duoFaceShopService';
import { DriverLocationService } from './driverLocationService';
import { DriverService } from './driverService';
import type { DispatchTrigger } from './dispatchTrigger';
import { rankByDistance } from './geo';
import type { GeoPoint } from './geo';
import { DUTY_LOCATION_STALE_AFTER_MS, getLocationFreshness } from './locationFreshness';

/** Statuses of a previous offer for the same order that rule that driver out for it. */
const EXCLUDING_STATUSES = ['rejected', 'cancelled'];

function toDate(value: unknown): Date | null {
  if (value instanceof Date) return value;
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate();
  }
  return null;
}

function isValidPoint(point: GeoPoint | null | undefined): point is GeoPoint {
  return (
    !!point &&
    Number.isFinite(point.latitude) &&
    Number.isFinite(point.longitude) &&
    Math.abs(point.latitude) <= 90 &&
    Math.abs(point.longitude) <= 180
  );
}

/**
 * Automatic nearest-driver dispatch (docs/decisions/026). A merchant only
 * raises a request; this service picks the driver. Nothing here accepts a
 * driver id from a client. Distances are used for ranking only and are never
 * returned or logged.
 */
export class DriverDispatchService implements DispatchTrigger {
  constructor(
    private readonly assignments: DeliveryAssignmentService = new DeliveryAssignmentService(),
    private readonly store: DeliveryAssignmentStore = new FirestoreDeliveryAssignmentStore(),
    private readonly drivers: DriverService = new DriverService(),
    private readonly locations: DriverLocationService = new DriverLocationService(),
    private readonly liveLocations: LiveDriverLocationStore = createLiveDriverLocationStore(),
    private readonly shopProvider: CustomerAppShopProvider = new FirestoreCustomerAppShopProvider(),
    private readonly geocoder: DeliveryGeocoder = createDeliveryGeocoder(),
    private readonly orderProvider: CustomerAppOrderProvider = new FirestoreCustomerAppOrderProvider(),
    private readonly now: () => Date = () => new Date(),
    private readonly shops: DuoFaceShopService = new DuoFaceShopService()
  ) {}

  /** Merchant-facing entry: shop ownership comes from the authenticated shop, never the client. */
  async requestDriver(shop: DuoFaceShop, orderId: string): Promise<DeliveryAssignment> {
    const customerAppShopId = this.assignments.requireLinkedCustomerAppShopId(shop);
    return this.dispatch(orderId, customerAppShopId);
  }

  /** Background re-offer after a rejection/expiry. "Nobody available" is a normal outcome here, not an error. */
  async redispatch(orderId: string, customerAppShopId: string): Promise<void> {
    try {
      await this.dispatch(orderId, customerAppShopId);
    } catch (err) {
      if (err instanceof AppError && err.statusCode === 409) return;
      throw err;
    }
  }

  async dispatch(orderId: string, customerAppShopId: string): Promise<DeliveryAssignment> {
    await this.requireOwnedOrder(orderId, customerAppShopId);

    const previous = (await this.store.listByOrderId(orderId)).flatMap((doc) => {
      const parsed = deliveryAssignmentSchema.safeParse(doc);
      return parsed.success ? [parsed.data] : [];
    });
    if (previous.some((a) => ACTIVE_ASSIGNMENT_STATUSES.includes(a.status))) {
      throw new AppError(409, `Order ${orderId} already has an active delivery assignment.`);
    }
    const excluded = new Set(previous.filter((a) => EXCLUDING_STATUSES.includes(a.status)).map((a) => a.driverId));

    const pickup = await this.resolvePickupPoint(customerAppShopId);
    if (!pickup) {
      throw new AppError(409, 'Shop location unavailable.');
    }

    const ranked = rankByDistance(pickup, await this.eligibleCandidates(excluded));
    // Never fall back to a far or unlocated driver: no eligible driver means no assignment.
    for (const candidate of ranked) {
      try {
        return await this.assignments.assignDriver({ orderId, customerAppShopId, driverId: candidate.driverId });
      } catch (err) {
        // The driver went inactive/missing between listing and assigning: try the next nearest.
        if (err instanceof AppError && (err.message === 'Driver not found.' || err.message === 'Driver is not active.')) continue;
        throw err;
      }
    }
    throw new AppError(409, 'No driver available nearby right now.');
  }

  private async requireOwnedOrder(orderId: string, customerAppShopId: string): Promise<void> {
    const raw = await this.orderProvider.getOrderById(orderId);
    // Missing and other-shop collapse to one 404 (docs/decisions/011).
    if (!raw) throw new AppError(404, 'Order not found.');
    const order = customerAppOrderSnapshotSchema.parse(raw);
    if (order.shopId !== customerAppShopId) throw new AppError(404, 'Order not found.');
  }

  /**
   * The stored Duo-Face shop pickupLocation wins (exact, correctable);
   * otherwise geocode the Customer App shop's text address (cached). Null =
   * unknown; never guessed.
   */
  private async resolvePickupPoint(customerAppShopId: string): Promise<GeoPoint | null> {
    try {
      const stored = (await this.shops.getByCustomerAppShopId(customerAppShopId))?.pickupLocation;
      if (isValidPoint(stored)) return { latitude: stored.latitude, longitude: stored.longitude };
    } catch {
      // A broken shop document must not block dispatch: fall back to the address.
    }
    try {
      const shop = (await this.shopProvider.getShop(customerAppShopId)) as { address?: unknown } | null;
      if (typeof shop?.address !== 'string' || shop.address.length === 0) return null;
      const point = await this.geocoder.geocode(shop.address);
      return isValidPoint(point) ? point : null;
    } catch {
      return null; // never log the address
    }
  }

  private async eligibleCandidates(excluded: Set<string>): Promise<Array<{ driverId: string; location: GeoPoint }>> {
    const active = await this.drivers.listActiveDrivers();
    const results = await Promise.all(
      active
        .filter((driver) => driver.onDuty === true && !excluded.has(driver.driverId))
        .map(async (driver) => {
          if (await this.isBusy(driver.driverId)) return null;
          const location = await this.locate(driver.driverId);
          return location ? { driverId: driver.driverId, location } : null;
        })
    );
    return results.flatMap((candidate) => (candidate ? [candidate] : []));
  }

  /** On any active delivery (including a still-pending offer) = not available. */
  private async isBusy(driverId: string): Promise<boolean> {
    return (await this.assignments.listActiveForDriver(driverId)).length > 0;
  }

  /** Live (Redis) fix first, else the last manual (Firestore) one; either must be recent. */
  private async locate(driverId: string): Promise<GeoPoint | null> {
    const now = this.now();
    try {
      const live = await this.liveLocations.get(driverId);
      if (live && isValidPoint(live) && getLocationFreshness(live.capturedAt, now, DUTY_LOCATION_STALE_AFTER_MS) === 'fresh') {
        return { latitude: live.latitude, longitude: live.longitude };
      }
    } catch {
      // Redis unavailable: fall through to the durable location.
    }
    try {
      const latest = await this.locations.getLatestLocation(driverId);
      if (!latest || !isValidPoint(latest)) return null;
      if (getLocationFreshness(toDate(latest.capturedAt), now, DUTY_LOCATION_STALE_AFTER_MS) !== 'fresh') return null;
      return { latitude: latest.latitude, longitude: latest.longitude };
    } catch {
      return null;
    }
  }
}
