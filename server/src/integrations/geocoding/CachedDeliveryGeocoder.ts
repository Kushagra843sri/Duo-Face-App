import { deliveryDestinationSchema } from '../../types/deliveryDestination';
import type { DeliveryDestinationStore } from '../firebase/FirestoreDeliveryDestinationStore';
import { hashNormalizedAddress, normalizeAddress } from './addressNormalization';
import type { DeliveryGeocoder, GeocodedDestination } from './DeliveryGeocoder';
import { GeocodingError } from './OpenCageGeocodingProvider';
import type { GeocodingProvider } from './OpenCageGeocodingProvider';

/**
 * The real DeliveryGeocoder: normalized-address cache in front of a
 * provider. Callers must already have authorized the request (it is only
 * ever reached from DeliveryOrderService after an assignment ownership
 * check) — there is no public geocode entry point.
 *
 * Never throws for geocoding problems: any failure yields null so the
 * delivery order is still returned (without a destination). Logs contain
 * only the address hash and a failure category — never the address, the
 * request URL, or provider responses.
 */
export class CachedDeliveryGeocoder implements DeliveryGeocoder {
  // Collapses concurrent lookups of the same address within this process.
  // Across instances a duplicate provider call is still possible (a rare
  // race); createIfAbsent guarantees it can't create a duplicate document.
  private readonly inFlight = new Map<string, Promise<GeocodedDestination | null>>();

  constructor(
    private readonly store: DeliveryDestinationStore,
    private readonly provider: GeocodingProvider
  ) {}

  async geocode(fullAddress: string): Promise<GeocodedDestination | null> {
    const normalized = normalizeAddress(fullAddress);
    if (!normalized) return null;
    const hash = hashNormalizedAddress(normalized);

    const pending = this.inFlight.get(hash);
    if (pending) return pending;

    const work = this.resolve(fullAddress.trim(), normalized, hash).finally(() => {
      this.inFlight.delete(hash);
    });
    this.inFlight.set(hash, work);
    return work;
  }

  private async resolve(address: string, normalized: string, hash: string): Promise<GeocodedDestination | null> {
    let needsRepair = false;
    try {
      const raw = await this.store.get(hash);
      if (raw) {
        const cached = deliveryDestinationSchema.safeParse(raw);
        // The stored normalizedAddress must match too: guards against a
        // corrupted/colliding document ever being served for this address.
        if (cached.success && cached.data.normalizedAddress === normalized && cached.data.addressHash === hash) {
          return { latitude: cached.data.latitude, longitude: cached.data.longitude };
        }
        console.warn(`CachedDeliveryGeocoder: malformed cached destination ${hash}; re-geocoding`);
        needsRepair = true;
      }
    } catch {
      console.warn(`CachedDeliveryGeocoder: cache read failed for destination ${hash}`);
      // Cache trouble must not block a usable destination; fall through to the provider.
    }

    let result;
    try {
      result = await this.provider.geocode(address);
    } catch (err) {
      const category = err instanceof GeocodingError ? err.category : 'unavailable';
      console.warn(`CachedDeliveryGeocoder: geocoding failed (${category}) for destination ${hash}`);
      return null;
    }

    const now = new Date();
    const data = {
      destinationId: hash,
      addressHash: hash,
      normalizedAddress: normalized,
      latitude: result.latitude,
      longitude: result.longitude,
      provider: this.provider.name,
      precision: result.precision,
      createdAt: now,
      updatedAt: now,
    };

    try {
      if (needsRepair) {
        await this.store.replace(hash, data);
      } else {
        await this.store.createIfAbsent(hash, data);
      }
    } catch {
      console.warn(`CachedDeliveryGeocoder: cache write failed for destination ${hash}`);
    }

    return { latitude: result.latitude, longitude: result.longitude };
  }
}
