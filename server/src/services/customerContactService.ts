import { AppError } from '../middleware/errorHandler';
import type { DuoFaceDriver } from '../types/duoFaceDriver';
import { DeliveryAssignmentService } from './deliveryAssignmentService';
import { DeliveryOrderService } from './deliveryOrderService';
import { haversineMeters } from './geo';

/** The driver may ask for the customer's number only this close to the delivery location (decision 032). */
export const CONTACT_RADIUS_METERS = 300;
/** A fix less precise than this cannot show the driver is "nearby". */
export const CONTACT_MAX_ACCURACY_METERS = 100;

const roundTo10 = (meters: number) => Math.max(10, Math.round(meters / 10) * 10);

/**
 * Releases the customer's phone number to the delivering driver, and only
 * when the driver proves (with a fresh GPS fix sent at tap time) that they are
 * within CONTACT_RADIUS_METERS of the delivery location while carrying the
 * order. The number is never logged and never part of any other response.
 */
export class CustomerContactService {
  constructor(
    private readonly assignments: DeliveryAssignmentService = new DeliveryAssignmentService(),
    private readonly orders: DeliveryOrderService = new DeliveryOrderService(assignments)
  ) {}

  async getPhoneNumber(
    driver: DuoFaceDriver,
    assignmentId: string,
    fix: { latitude: number; longitude: number; accuracyMeters?: number }
  ): Promise<{ phoneNumber: string }> {
    const assignment = await this.assignments.getById(assignmentId);
    // Same 404 for missing and another driver's assignment.
    if (!assignment || assignment.driverId !== driver.driverId) throw new AppError(404, 'Assignment not found.');
    if (assignment.status !== 'picked_up') throw new AppError(409, 'You can call the customer once you have picked up the order.');

    const order = await this.orders.getForDriverWithPhone(driver, assignmentId);
    if (!order.destination) throw new AppError(409, 'The delivery location is unavailable, so the customer cannot be called from here.');
    if (typeof fix.accuracyMeters !== 'number' || fix.accuracyMeters > CONTACT_MAX_ACCURACY_METERS) {
      throw new AppError(409, 'Your GPS signal is not accurate enough yet. Move to open sky and try again.');
    }
    const distance = haversineMeters(order.destination, fix);
    if (distance > CONTACT_RADIUS_METERS) {
      throw new AppError(409, `You are about ${roundTo10(distance)} m from the delivery location. Get within ${CONTACT_RADIUS_METERS} m to call the customer.`);
    }
    if (!order.delivery.phoneNumber) throw new AppError(409, 'This order has no phone number.');
    return { phoneNumber: order.delivery.phoneNumber };
  }
}
