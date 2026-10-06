import { LiveLocationUnavailableError } from '../integrations/redis/LiveDriverLocationStore';
import type { LiveDriverLocationStore } from '../integrations/redis/LiveDriverLocationStore';
import { createLiveDriverLocationStore } from '../integrations/redis/createLiveDriverLocationStore';
import { AppError } from '../middleware/errorHandler';
import { deliveryEventHub } from '../realtime/deliveryEvents';
import type { DeliveryEventPublisher } from '../realtime/deliveryEvents';
import type { DeliveryAssignment } from '../types/deliveryAssignment';
import type { DriverLocationInput } from '../types/driverLocation';
import type { LiveDriverLocation } from '../types/liveDriverLocation';
import { DeliveryAssignmentService } from './deliveryAssignmentService';
import { nearbyHub } from './driverNearby';
import type { NearbyWatcher } from './driverNearby';
import { DriverLocationService } from './driverLocationService';
import { getLocationFreshness, LIVE_LOCATION_STALE_AFTER_MS } from './locationFreshness';
import { isTrackingEligible } from './trackingPolicy';

/**
 * Eligibility (an assignment read) is cached in-process for this long so a
 * ~10 s GPS cadence doesn't become a Firestore read per ping. Cost of the
 * cache: after an assignment leaves accepted/picked_up, a driver's client
 * could keep publishing for up to this long (the read side re-checks
 * eligibility, so nothing is served for an ineligible assignment).
 */
export const ELIGIBILITY_CACHE_MS = 15_000;

/** Durable Firestore snapshot at most this often per driver while tracking (not per ping). */
export const DURABLE_SNAPSHOT_INTERVAL_MS = 60_000;

export interface LiveLocationView {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  heading?: number;
  speedMps?: number;
  capturedAt: string;
  freshness: 'fresh' | 'stale';
}

/**
 * Callers must already have authenticated the driver; `driverId` is
 * always the verified driver's id. Firestore is touched only for (a) the
 * cached assignment-eligibility read and (b) one durable snapshot per
 * minute — never per ping. Redis trouble becomes a 503, never a Firestore
 * fallback for the ping itself.
 */
export class DriverTrackingService {
  private readonly eligibleUntil = new Map<string, { until: number; orderId: string; status: string }>();
  private readonly lastSnapshotAt = new Map<string, number>();

  constructor(
    private readonly assignments: DeliveryAssignmentService = new DeliveryAssignmentService(),
    private readonly liveStore: LiveDriverLocationStore = createLiveDriverLocationStore(),
    private readonly durableLocations: DriverLocationService = new DriverLocationService(),
    private readonly now: () => number = Date.now,
    private readonly events: DeliveryEventPublisher = deliveryEventHub,
    /** Tells the customer when their delivery partner is close (no-op until the real server installs it). */
    private readonly nearby: NearbyWatcher = nearbyHub
  ) {}

  /**
   * Ownership + eligibility + the one-active-assignment rule.
   * - not this driver's / missing / rejected -> 404 (nothing revealed)
   * - assigned, delivered, cancelled          -> 409 not eligible
   * - driver has >1 tracking-eligible assignment -> 409 ambiguous (we never guess)
   */
  private async authorize(driverId: string, assignmentId: string): Promise<DeliveryAssignment> {
    const cacheKey = `${driverId}:${assignmentId}`;
    const all = await this.assignments.listByDriverId(driverId);
    const assignment = all.find((a) => a.assignmentId === assignmentId);

    if (!assignment || assignment.status === 'rejected') {
      this.eligibleUntil.delete(cacheKey);
      throw new AppError(404, 'Assignment not found.');
    }
    if (!isTrackingEligible(assignment.status)) {
      this.eligibleUntil.delete(cacheKey);
      throw new AppError(409, 'This assignment is not eligible for live tracking.');
    }
    if (all.filter((a) => isTrackingEligible(a.status)).length > 1) {
      this.eligibleUntil.delete(cacheKey);
      throw new AppError(
        409,
        'You have more than one active delivery. Live tracking supports one at a time; finish or hand off the others first.'
      );
    }

    this.eligibleUntil.set(cacheKey, { until: this.now() + ELIGIBILITY_CACHE_MS, orderId: assignment.orderId, status: assignment.status });
    return assignment;
  }

  /** @returns the orderId (for realtime fan-out) and status of the authorized assignment. */
  private async authorizeCached(driverId: string, assignmentId: string): Promise<{ orderId: string; status: string }> {
    const cached = this.eligibleUntil.get(`${driverId}:${assignmentId}`);
    if (cached !== undefined && cached.until > this.now()) return { orderId: cached.orderId, status: cached.status };
    const assignment = await this.authorize(driverId, assignmentId);
    return { orderId: assignment.orderId, status: assignment.status };
  }

  async publishLocation(driverId: string, assignmentId: string, input: DriverLocationInput): Promise<{ capturedAt: string }> {
    const { orderId, status } = await this.authorizeCached(driverId, assignmentId);

    const capturedAt = new Date(this.now());
    const live: LiveDriverLocation = { driverId, assignmentId, ...input, capturedAt };
    try {
      await this.liveStore.update(live);
    } catch (err) {
      throw this.toServiceError(err, driverId, assignmentId);
    }

    // Realtime fan-out to customers watching this order: only lat/lng/time,
    // fire-and-forget (a fan-out problem never fails the driver's ping).
    this.events.publish(orderId, {
      type: 'driver_location',
      location: { latitude: input.latitude, longitude: input.longitude, capturedAt: capturedAt.toISOString() },
    });

    // Only once the order is in the driver's hands is "nearby" meaningful. Fire-and-forget.
    if (status === 'picked_up') {
      void this.nearby.onPosition(orderId, { latitude: input.latitude, longitude: input.longitude, ...(input.accuracyMeters !== undefined ? { accuracyMeters: input.accuracyMeters } : {}) });
    }

    await this.maybeSnapshot(driverId, input);
    return { capturedAt: capturedAt.toISOString() };
  }

  /** Best-effort: a Firestore hiccup must not fail an otherwise-successful live update. */
  private async maybeSnapshot(driverId: string, input: DriverLocationInput): Promise<void> {
    const last = this.lastSnapshotAt.get(driverId);
    if (last !== undefined && this.now() - last < DURABLE_SNAPSHOT_INTERVAL_MS) return;

    // Claim the slot first so concurrent pings don't all snapshot.
    this.lastSnapshotAt.set(driverId, this.now());
    try {
      await this.durableLocations.updateLocation(driverId, input);
    } catch {
      this.lastSnapshotAt.delete(driverId);
      console.warn(`DriverTrackingService: durable snapshot failed for driver ${driverId}`);
    }
  }

  async getLiveLocation(driverId: string, assignmentId: string): Promise<LiveLocationView> {
    await this.authorize(driverId, assignmentId);

    let live: LiveDriverLocation | null;
    try {
      live = await this.liveStore.get(driverId);
    } catch (err) {
      throw this.toServiceError(err, driverId, assignmentId);
    }
    // A position published for a different assignment is not this one's.
    if (!live || live.assignmentId !== assignmentId) {
      throw new AppError(404, 'No live location for this assignment.');
    }

    return {
      latitude: live.latitude,
      longitude: live.longitude,
      ...(live.accuracyMeters !== undefined ? { accuracyMeters: live.accuracyMeters } : {}),
      ...(live.heading !== undefined ? { heading: live.heading } : {}),
      ...(live.speedMps !== undefined ? { speedMps: live.speedMps } : {}),
      capturedAt: live.capturedAt.toISOString(),
      freshness: getLocationFreshness(live.capturedAt, new Date(this.now()), LIVE_LOCATION_STALE_AFTER_MS),
    };
  }

  /** Idempotent. Removes only the caller's own live position. */
  async stopTracking(driverId: string): Promise<void> {
    this.lastSnapshotAt.delete(driverId);
    for (const key of this.eligibleUntil.keys()) if (key.startsWith(`${driverId}:`)) this.eligibleUntil.delete(key);
    try {
      await this.liveStore.remove(driverId);
    } catch (err) {
      throw this.toServiceError(err, driverId, '-');
    }
  }

  private toServiceError(err: unknown, driverId: string, assignmentId: string): Error {
    if (err instanceof LiveLocationUnavailableError) {
      // Ids + category only: never coordinates.
      console.warn(`DriverTrackingService: live store unavailable (driver ${driverId}, assignment ${assignmentId})`);
      return new AppError(503, 'Live tracking is temporarily unavailable.');
    }
    return err instanceof Error ? err : new Error('unexpected tracking error');
  }
}
