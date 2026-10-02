/**
 * Only the 8 status values the backend actually declares (server/src/types/customerAppOrder.ts).
 * Confirmed from source: only "pending" and "cancelled" are ever actually
 * produced by the Customer App today (see docs/decisions/011) — the rest
 * are mapped here for when/if they're ever used, not because they're
 * expected now.
 */
const ORDER_STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  preparing: 'Preparing',
  ready_for_pickup: 'Ready for pickup',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  rejected: 'Rejected',
};

export function formatOrderStatus(status: string): string {
  return ORDER_STATUS_LABELS[status] ?? status;
}
