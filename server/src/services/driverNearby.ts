import { FirestoreCustomerStore } from '../integrations/firebase/FirestoreCustomerStore';
import type { CustomerStore } from '../integrations/firebase/FirestoreCustomerStore';
import { createDeliveryGeocoder } from '../integrations/geocoding/createDeliveryGeocoder';
import type { DeliveryGeocoder } from '../integrations/geocoding/DeliveryGeocoder';
import { appEvents } from './appEvents';
import type { AppEvents } from './appEvents';
import { savedDeliveryPoint } from './deliveryPoint';
import { haversineMeters } from './geo';
import type { GeoPoint } from './geo';

/** "Nearby" means the driver is within this distance of the delivery address. */
export const NEARBY_METERS = 300;
/** Position checks per order are at most this often (pings come every ~10 s; a check can mean a lookup). */
const CHECK_EVERY_MS = 20_000;
/** A GPS fix less precise than this is not trusted to say "nearby". */
const MAX_TRUSTED_ACCURACY_METERS = 100;
const PRUNE_ABOVE = 500;

export interface NearbyWatcher {
  /** Called with each driver position while they carry an order to the customer. Never throws. */
  onPosition(orderId: string, position: GeoPoint & { accuracyMeters?: number }): Promise<void>;
}

export class NoopNearbyWatcher implements NearbyWatcher {
  async onPosition(): Promise<void> {}
}

/** Delegating holder: a no-op until server.ts installs the real watcher (so tests never notify anyone). */
export class NearbyHub implements NearbyWatcher {
  private delegate: NearbyWatcher = new NoopNearbyWatcher();
  install(delegate: NearbyWatcher): void {
    this.delegate = delegate;
  }
  onPosition(orderId: string, position: GeoPoint & { accuracyMeters?: number }): Promise<void> {
    try {
      return this.delegate.onPosition(orderId, position).catch(() => undefined);
    } catch {
      return Promise.resolve();
    }
  }
}

export const nearbyHub = new NearbyHub();

/**
 * Tells the customer their delivery partner is close. The destination is the
 * customer's saved GPS point when the address has one, otherwise the cached
 * server-side geocode (decision 021); with neither, nothing is sent. Once per
 * order (also guaranteed across restarts by the notification's own
 * once-only key).
 */
export class DriverNearbyService implements NearbyWatcher {
  private readonly lastCheck = new Map<string, number>();
  private readonly notified = new Set<string>();

  constructor(
    private readonly orders: CustomerStore = new FirestoreCustomerStore(),
    private readonly geocoder: DeliveryGeocoder = createDeliveryGeocoder(),
    private readonly events: AppEvents = appEvents,
    private readonly now: () => number = Date.now,
    private readonly radiusMeters: number = NEARBY_METERS
  ) {}

  async onPosition(orderId: string, position: GeoPoint & { accuracyMeters?: number }): Promise<void> {
    if (this.notified.has(orderId)) return;
    if (position.accuracyMeters !== undefined && position.accuracyMeters > MAX_TRUSTED_ACCURACY_METERS) return;

    const t = this.now();
    const last = this.lastCheck.get(orderId);
    if (last !== undefined && t - last < CHECK_EVERY_MS) return;
    this.prune(t);
    this.lastCheck.set(orderId, t);

    const destination = await this.destinationOf(orderId);
    if (!destination) return;
    if (haversineMeters(position, destination) > this.radiusMeters) return;

    this.notified.add(orderId);
    await this.events.driverNearby(orderId);
  }

  private async destinationOf(orderId: string): Promise<GeoPoint | null> {
    const order = await this.orders.getOrder(orderId);
    const delivery = order?.delivery as { latitude?: unknown; longitude?: unknown; fullAddress?: unknown } | undefined;
    if (!delivery) return null;
    const saved = savedDeliveryPoint(delivery);
    if (saved) return saved;
    if (typeof delivery.fullAddress !== 'string') return null;
    const geocoded = await this.geocoder.geocode(delivery.fullAddress);
    return geocoded && Number.isFinite(geocoded.latitude) && Number.isFinite(geocoded.longitude) ? geocoded : null;
  }

  private prune(t: number): void {
    if (this.lastCheck.size <= PRUNE_ABOVE) return;
    for (const [id, at] of this.lastCheck) if (t - at > 5 * 60_000) this.lastCheck.delete(id);
    if (this.notified.size > PRUNE_ABOVE * 4) this.notified.clear(); // the notification's own once-only key still protects
  }
}
