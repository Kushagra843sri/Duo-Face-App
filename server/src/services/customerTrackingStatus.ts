import type { CustomerDeliveryStatus } from '../realtime/deliveryEvents';
import type { DeliveryAssignmentStatus } from '../types/deliveryAssignment';

/**
 * Customer-facing delivery status. A `rejected` assignment is shown as
 * `pending` (the customer is still waiting for a driver; how many drivers
 * declined is none of their business). No assignment is also `pending`.
 */
export function toCustomerStatus(status: DeliveryAssignmentStatus | undefined): CustomerDeliveryStatus {
  switch (status) {
    case 'assigned':
    case 'accepted':
    case 'picked_up':
    case 'delivered':
    case 'cancelled':
      return status;
    default:
      return 'pending';
  }
}

/** Once terminal, nothing more will happen on this order's tracking channel. */
export function isTerminalCustomerStatus(status: CustomerDeliveryStatus): boolean {
  return status === 'delivered' || status === 'cancelled';
}
