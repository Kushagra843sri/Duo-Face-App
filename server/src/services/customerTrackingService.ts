import { FirestoreCustomerAppOrderProvider } from '../integrations/customerApp/FirestoreCustomerAppOrderProvider';
import type { CustomerAppOrderProvider } from '../integrations/customerApp/CustomerAppOrderProvider';
import { createDeliveryGeocoder } from '../integrations/geocoding/createDeliveryGeocoder';
import type { DeliveryGeocoder } from '../integrations/geocoding/DeliveryGeocoder';
import { savedDeliveryPoint } from './deliveryPoint';
import { LiveLocationUnavailableError } from '../integrations/redis/LiveDriverLocationStore';
import type { LiveDriverLocationStore } from '../integrations/redis/LiveDriverLocationStore';
import { createLiveDriverLocationStore } from '../integrations/redis/createLiveDriverLocationStore';
import { AppError } from '../middleware/errorHandler';
import type { CustomerDeliveryStatus } from '../realtime/deliveryEvents';
import { customerAppOrderOwnershipSchema } from '../types/customerAppOrder';
import { DeliveryAssignmentService } from './deliveryAssignmentService';
import { isTerminalCustomerStatus, toCustomerStatus } from './customerTrackingStatus';
import { getLocationFreshness, LIVE_LOCATION_STALE_AFTER_MS } from './locationFreshness';
import { isTrackingEligible } from './trackingPolicy';

/**
 * What a customer may see. No driver identity or contact data, no ids, no
 * accuracy/heading/speed, no infrastructure details.
 */
export interface CustomerTracking {
  /** True only when a live driver position is currently exposed. */
  available: boolean;
  status: CustomerDeliveryStatus;
  location?: {
    latitude: number;
    longitude: number;
    capturedAt: string;
    /** From the shared live freshness policy. A stale position is returned (bounded by the Redis TTL) but marked fresh:false. */
    fresh: boolean;
  };
  destination?: { latitude: number; longitude: number };
  updatedAt: string;
}

export interface TrackingSnapshot {
  tracking: CustomerTracking;
  /** Whether a realtime subscription still makes sense (false once delivered/cancelled). */
  joinable: boolean;
}

/**
 * Customer authorization is NOT the Duo-Face role model. The caller is any
 * verified Firebase user (the Customer App's own phone-auth users); the one
 * authoritative check is `order.customerId === caller's Firebase UID`,
 * read from the Customer App order (read-only). A merchant or driver
 * identity gets no special treatment: for someone else's order they simply
 * fail this check. Missing, malformed-ownership and not-yours orders are
 * all the same 404 (nothing is revealed).
 */
export class CustomerTrackingService {
  constructor(
    private readonly orders: CustomerAppOrderProvider = new FirestoreCustomerAppOrderProvider(),
    private readonly assignments: DeliveryAssignmentService = new DeliveryAssignmentService(),
    private readonly liveStore: LiveDriverLocationStore = createLiveDriverLocationStore(),
    private readonly geocoder: DeliveryGeocoder = createDeliveryGeocoder(),
    private readonly now: () => number = Date.now
  ) {}

  async getSnapshot(firebaseUid: string, orderId: string): Promise<TrackingSnapshot> {
    const raw = await this.orders.getOrderById(orderId);
    const parsed = raw ? customerAppOrderOwnershipSchema.safeParse(raw) : null;
    if (!parsed || !parsed.success || parsed.data.orderId !== orderId || parsed.data.customerId !== firebaseUid) {
      throw new AppError(404, 'Order not found.');
    }
    const order = parsed.data;

    const assignment = await this.assignments.getCurrentForOrder(orderId, order.shopId);
    const status = toCustomerStatus(assignment?.status);
    const updatedAt = new Date(this.now()).toISOString();
    const joinable = !isTerminalCustomerStatus(status);

    // Live tracking only for accepted / picked_up — the same policy the driver side enforces.
    if (!assignment || !isTrackingEligible(assignment.status)) {
      return { tracking: { available: false, status, updatedAt }, joinable };
    }

    const tracking: CustomerTracking = { available: false, status, updatedAt };

    const destination = savedDeliveryPoint(order.delivery) ?? (await this.resolveDestination(order.delivery.fullAddress));
    if (destination) tracking.destination = destination;

    try {
      const live = await this.liveStore.get(assignment.driverId);
      // A position that belongs to a different (e.g. previous) assignment is never exposed.
      if (live && live.assignmentId === assignment.assignmentId) {
        tracking.available = true;
        tracking.location = {
          latitude: live.latitude,
          longitude: live.longitude,
          capturedAt: live.capturedAt.toISOString(),
          fresh: getLocationFreshness(live.capturedAt, new Date(this.now()), LIVE_LOCATION_STALE_AFTER_MS) === 'fresh',
        };
      }
    } catch (err) {
      // Read-only customer view degrades to "unavailable" rather than erroring.
      if (!(err instanceof LiveLocationUnavailableError)) throw err;
      console.warn(`CustomerTrackingService: live store unavailable (order ${orderId})`);
    }

    return { tracking, joinable };
  }

  /** The customer's own address, via the cached server-side geocoding boundary; failures mean "no destination". */
  private async resolveDestination(fullAddress: string): Promise<{ latitude: number; longitude: number } | null> {
    try {
      const result = await this.geocoder.geocode(fullAddress);
      const valid =
        result &&
        Number.isFinite(result.latitude) &&
        Number.isFinite(result.longitude) &&
        Math.abs(result.latitude) <= 90 &&
        Math.abs(result.longitude) <= 180;
      return valid ? { latitude: result.latitude, longitude: result.longitude } : null;
    } catch {
      return null;
    }
  }
}
