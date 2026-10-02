import { ApiError } from '@/api/client';
import { getDriverAssignment, publishTrackingLocation, stopTrackingLocation } from '@/api/driver';
import { authService } from '@/lib/authService';
import { getLocationPermission, requestLocationPermission, toDriverLocationInput, watchForegroundLocation } from '@/lib/locationService';
import { canStartTracking, shouldSendFix } from '@/lib/trackingPolicy';

export interface TrackingSnapshot {
  status: 'idle' | 'starting' | 'active';
  assignmentId: string | null;
  /** Epoch ms of the last update the server accepted. */
  lastSuccessAt: number | null;
  error: string | null;
}

const IDLE: TrackingSnapshot = { status: 'idle', assignmentId: null, lastSuccessAt: null, error: null };

/**
 * Foreground live tracking for ONE assignment. The screen that owns the
 * tracking UI must call stopTracking() when it unmounts or the app leaves
 * the foreground — there is deliberately no background operation.
 *
 * Nothing here decides the driver's identity or the assignment's
 * eligibility: the server derives the driver from the token and re-checks
 * ownership/status on every publish (the checks below are for fast,
 * friendly failure).
 */
class TrackingController {
  private snapshot: TrackingSnapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  private subscription: { remove: () => void } | null = null;
  private lastSentAt: number | null = null;
  private sending = false;

  // Arrow properties: stable identities for useSyncExternalStore.
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  isTracking(): boolean {
    return this.snapshot.status !== 'idle';
  }

  private set(next: Partial<TrackingSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    this.listeners.forEach((listener) => listener());
  }

  async startTracking(assignmentId: string): Promise<void> {
    if (this.isTracking()) return;
    this.lastSentAt = null;
    this.snapshot = { status: 'starting', assignmentId, lastSuccessAt: null, error: null };
    this.listeners.forEach((listener) => listener());

    try {
      if (!authService.getCurrentUser()) throw new Error('Please sign in to start tracking.');

      // Ownership is enforced by the server (404 for another driver's assignment).
      const assignment = await getDriverAssignment(assignmentId);
      if (!canStartTracking(assignment.status)) {
        throw new Error('Live tracking is available once you have accepted the delivery, until it is delivered.');
      }

      let permission = await getLocationPermission();
      if (permission.status !== 'granted' && permission.canAskAgain) {
        permission = await requestLocationPermission(); // explicit user action (Start button)
      }
      if (permission.status !== 'granted') {
        throw new Error('Location permission is required for live tracking.');
      }

      // Bail out if stopTracking() ran while we were awaiting.
      if (this.snapshot.status !== 'starting') return;

      this.subscription = await watchForegroundLocation(
        (coords) => void this.handleFix(assignmentId, coords),
        () => this.set({ error: 'Could not read your location.' })
      );
      if (this.snapshot.status !== 'starting') {
        this.subscription.remove();
        this.subscription = null;
        return;
      }
      this.set({ status: 'active' });
    } catch (error) {
      this.teardown();
      this.set({ ...IDLE, error: this.messageFor(error) });
    }
  }

  private async handleFix(
    assignmentId: string,
    coords: Parameters<typeof toDriverLocationInput>[0] & { accuracy?: number | null }
  ) {
    const now = Date.now();
    if (this.snapshot.status !== 'active' || this.sending || !shouldSendFix(coords, this.lastSentAt, now)) return;

    this.sending = true;
    this.lastSentAt = now;
    try {
      await publishTrackingLocation(assignmentId, toDriverLocationInput(coords));
      if (this.snapshot.status === 'active') this.set({ lastSuccessAt: Date.now(), error: null });
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404, 409].includes(error.status)) {
        // Not allowed to track this assignment (any more): stop, don't keep retrying.
        await this.stopTracking();
        this.set({ error: this.messageFor(error) });
      } else if (error instanceof ApiError && error.status === 429) {
        // Rate limited: skip this fix, keep watching.
      } else if (this.snapshot.status === 'active') {
        this.set({ error: this.messageFor(error) }); // 503 / network: keep watching, surface it
      }
    } finally {
      this.sending = false;
    }
  }

  private teardown() {
    this.subscription?.remove();
    this.subscription = null;
    this.sending = false;
    this.lastSentAt = null;
  }

  /** Stops the watcher and (best effort) tells the backend to drop the live position. */
  async stopTracking(): Promise<void> {
    const wasTracking = this.isTracking();
    this.teardown();
    this.set({ ...IDLE });
    if (!wasTracking) return;
    try {
      await stopTrackingLocation();
    } catch {
      // Best effort: the Redis TTL removes the position anyway.
    }
  }

  private messageFor(error: unknown): string {
    if (error instanceof ApiError) {
      if (error.status === 503) return 'Live tracking is temporarily unavailable. Retrying with the next update.';
      return error.message;
    }
    return error instanceof Error ? error.message : 'Live tracking failed.';
  }
}

export const trackingController = new TrackingController();
