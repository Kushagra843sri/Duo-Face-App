import { AppError } from '../middleware/errorHandler';
import type { DuoFaceDriver } from '../types/duoFaceDriver';
import { DeliveryAssignmentService } from './deliveryAssignmentService';
import { DriverService } from './driverService';
import { DriverTrackingService } from './driverTrackingService';

export interface DutyView {
  onDuty: boolean;
  dutyChangedAt: string | null;
}

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
}

export function toDutyView(driver: DuoFaceDriver): DutyView {
  return { onDuty: driver.onDuty === true, dutyChangedAt: toIso(driver.dutyChangedAt) };
}

/**
 * A driver activates / deactivates themselves (docs/decisions/027). While on
 * duty the app sends a location every minute; dispatch only offers orders to
 * on-duty drivers. `driverId` is always the authenticated driver's id.
 */
export class DriverDutyService {
  constructor(
    private readonly drivers: DriverService = new DriverService(),
    private readonly assignments: DeliveryAssignmentService = new DeliveryAssignmentService(),
    private readonly tracking: DriverTrackingService = new DriverTrackingService()
  ) {}

  async getDuty(driverId: string): Promise<DutyView> {
    const driver = await this.drivers.getById(driverId);
    if (!driver) throw new AppError(404, 'Driver not found.');
    return toDutyView(driver);
  }

  async setDuty(driverId: string, onDuty: boolean): Promise<DutyView> {
    if (!onDuty) {
      // Never leave an order with a driver nobody can see: finish or reject it first.
      // An offer nobody answered in time is dead, not "active": expire it first so it can never block going off duty.
      await this.assignments.expireStaleOffersForDriver(driverId);
      const active = await this.assignments.listActiveForDriver(driverId);
      if (active.length > 0) {
        throw new AppError(409, 'Finish or reject your current delivery first.');
      }
    }

    const driver = await this.drivers.setDuty(driverId, onDuty);

    if (!onDuty) {
      try {
        await this.tracking.stopTracking(driverId); // drop any live (Redis) position
      } catch {
        // Best effort: the Redis TTL removes it anyway.
      }
    }
    return toDutyView(driver);
  }
}
