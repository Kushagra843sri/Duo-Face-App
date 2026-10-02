import { AppError } from '../middleware/errorHandler';
import type { DeliveryAssignment } from '../types/deliveryAssignment';
import type { DuoFaceDriver } from '../types/duoFaceDriver';
import { DeliveryAssignmentService } from './deliveryAssignmentService';
import { DeliveryOrderService } from './deliveryOrderService';
import { haversineMeters } from './geo';

/** "Mark delivered" is only allowed this close to the customer (docs/decisions/028). */
export const DELIVERY_RADIUS_METERS = 50;

/**
 * A fix with a wider error circle than the radius cannot prove "within 50 m"
 * (it could be anywhere inside its own circle), so it is refused outright.
 */
export const MAX_FIX_ACCURACY_METERS = 50;

export type DeliveryProof =
  | { location: { latitude: number; longitude: number; accuracyMeters?: number }; otp?: undefined }
  | { otp: string; location?: undefined };

const roundTo10 = (meters: number) => Math.max(10, Math.round(meters / 10) * 10);

/**
 * The only path to `delivered` for a driver. Exactly one proof is required:
 *  - a fresh GPS fix within DELIVERY_RADIUS_METERS of the customer, or
 *  - the customer's delivery code (the fallback when the geocoded point is
 *    off or GPS is poor at the door).
 * The distance hint is rounded and never reveals the customer's coordinates.
 */
export class DeliveryProofService {
  constructor(
    private readonly assignments: DeliveryAssignmentService = new DeliveryAssignmentService(),
    private readonly orders: DeliveryOrderService = new DeliveryOrderService(assignments)
  ) {}

  async deliver(driver: DuoFaceDriver, assignmentId: string, proof: DeliveryProof): Promise<DeliveryAssignment> {
    const assignment = await this.assignments.getById(assignmentId);
    // Same 404 for missing and another driver's assignment (nothing leaks).
    if (!assignment || assignment.driverId !== driver.driverId) {
      throw new AppError(404, 'Assignment not found.');
    }
    if (assignment.status !== 'picked_up') {
      throw new AppError(409, `Cannot deliver an assignment that is ${assignment.status}.`);
    }

    if (proof.otp !== undefined) {
      await this.assignments.verifyDeliveryOtp(assignmentId, driver.driverId, proof.otp);
    } else {
      await this.requireWithinRadius(driver, assignmentId, proof.location);
    }
    return this.assignments.markDelivered(assignmentId, driver.driverId);
  }

  private async requireWithinRadius(
    driver: DuoFaceDriver,
    assignmentId: string,
    fix: { latitude: number; longitude: number; accuracyMeters?: number }
  ): Promise<void> {
    const order = await this.orders.getForDriver(driver, assignmentId);
    if (!order.destination) {
      throw new AppError(409, 'The delivery location is unavailable. Ask the customer for their delivery code.');
    }
    if (typeof fix.accuracyMeters !== 'number' || fix.accuracyMeters > MAX_FIX_ACCURACY_METERS) {
      throw new AppError(409, 'Your GPS signal is not accurate enough yet. Move to open sky and try again.');
    }
    const distance = haversineMeters(order.destination, fix);
    if (distance > DELIVERY_RADIUS_METERS) {
      throw new AppError(409, `You are about ${roundTo10(distance)} m from the delivery location. Get within ${DELIVERY_RADIUS_METERS} m to mark it delivered.`);
    }
  }
}
