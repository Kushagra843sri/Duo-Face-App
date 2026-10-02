import { FirestoreDriverLocationStore } from '../integrations/firebase/FirestoreDriverLocationStore';
import type { DriverLocationStore } from '../integrations/firebase/FirestoreDriverLocationStore';
import { driverLocationInputSchema, driverLocationSchema } from '../types/driverLocation';
import type { DriverLocation, DriverLocationInput } from '../types/driverLocation';

/**
 * Callers must have already authorized the actor: `driverId` here is
 * always the authenticated driver's id (req.driver.driverId), never a
 * Firebase UID and never client input.
 */
export class DriverLocationService {
  constructor(private readonly store: DriverLocationStore = new FirestoreDriverLocationStore()) {}

  /** Throws on a malformed stored document or one whose driverId doesn't match its id. */
  async getLatestLocation(driverId: string): Promise<DriverLocation | null> {
    const raw = await this.store.get(driverId);
    if (!raw) return null;

    const location = driverLocationSchema.parse(raw);
    if (location.driverId !== driverId) {
      throw new Error(`duo_face_driver_locations/${driverId} has a mismatched driverId field`);
    }
    return location;
  }

  /**
   * Overwrites the driver's single latest-location document. Input is
   * re-validated here (defense in depth); capturedAt is the server's
   * clock — the device's clock is not trusted.
   */
  async updateLocation(driverId: string, input: DriverLocationInput): Promise<DriverLocation> {
    const location = driverLocationInputSchema.parse(input);
    const now = new Date();

    await this.store.set(driverId, {
      driverId,
      latitude: location.latitude,
      longitude: location.longitude,
      ...(location.accuracyMeters !== undefined ? { accuracyMeters: location.accuracyMeters } : {}),
      ...(location.heading !== undefined ? { heading: location.heading } : {}),
      ...(location.speedMps !== undefined ? { speedMps: location.speedMps } : {}),
      capturedAt: now,
      updatedAt: now,
    });

    const stored = await this.getLatestLocation(driverId);
    if (!stored) {
      throw new Error(`duo_face_driver_locations/${driverId} was not found after writing it`);
    }
    return stored;
  }
}
