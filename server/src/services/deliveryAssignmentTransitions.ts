import type { DeliveryAssignmentStatus } from '../types/deliveryAssignment';

/**
 * The one centralized delivery-assignment state machine — every transition
 * check (service methods, and indirectly every route) goes through
 * isValidTransition rather than scattering per-route status comparisons.
 *
 *   assigned
 *    ├──> accepted ──> picked_up ──> delivered
 *    ├──> rejected
 *    └──> cancelled   (the offer expired unanswered)
 *
 * `rejected`, `delivered`, and `cancelled` are terminal — no entry here has
 * an outgoing edge from any of them. `cancelled` is produced only by an
 * unanswered offer expiring (docs/decisions/026-automatic-nearest-driver-dispatch.md);
 * drivers cannot trigger it.
 */
export const ALLOWED_TRANSITIONS: Record<DeliveryAssignmentStatus, DeliveryAssignmentStatus[]> = {
  assigned: ['accepted', 'rejected', 'cancelled'],
  accepted: ['picked_up'],
  picked_up: ['delivered'],
  rejected: [],
  delivered: [],
  cancelled: [],
};

export function isValidTransition(from: DeliveryAssignmentStatus, to: DeliveryAssignmentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

type TimestampField = 'acceptedAt' | 'cancelledAt' | 'rejectedAt' | 'pickedUpAt' | 'deliveredAt';

export const TIMESTAMP_FIELD_BY_STATUS: Partial<Record<DeliveryAssignmentStatus, TimestampField>> = {
  accepted: 'acceptedAt',
  rejected: 'rejectedAt',
  picked_up: 'pickedUpAt',
  delivered: 'deliveredAt',
  cancelled: 'cancelledAt',
};
