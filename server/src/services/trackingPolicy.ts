import type { DeliveryAssignmentStatus } from '../types/deliveryAssignment';

/**
 * The single definition of when a driver may publish live location:
 * only after accepting, through pickup. Not while merely `assigned`
 * (hasn't committed), and never after delivered / rejected / cancelled.
 * Evaluating this never changes assignment status.
 */
export const TRACKING_ELIGIBLE_STATUSES: readonly DeliveryAssignmentStatus[] = ['accepted', 'picked_up'];

export function isTrackingEligible(status: DeliveryAssignmentStatus): boolean {
  return TRACKING_ELIGIBLE_STATUSES.includes(status);
}
