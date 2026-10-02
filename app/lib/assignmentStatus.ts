/**
 * The 6 status values the backend declares
 * (server/src/types/deliveryAssignment.ts). Mirrors app/lib/orderStatus.ts.
 */
const ASSIGNMENT_STATUS_LABELS: Record<string, string> = {
  assigned: 'Assigned',
  accepted: 'Accepted',
  rejected: 'Rejected',
  picked_up: 'Picked up',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

export function formatAssignmentStatus(status: string): string {
  return ASSIGNMENT_STATUS_LABELS[status] ?? status;
}
