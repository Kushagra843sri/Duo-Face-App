import type { MerchantDeliveryAssignment } from '@/api/merchant';

export interface TimelineEntry {
  label: string;
  iso: string;
}

/**
 * Lifecycle history built only from the timestamps the backend actually
 * returned — an unset timestamp produces no entry, nothing is inferred.
 */
export function buildDeliveryTimeline(delivery: MerchantDeliveryAssignment): TimelineEntry[] {
  const candidates: Array<[string, string | null | undefined]> = [
    ['Assigned', delivery.assignedAt],
    ['Accepted', delivery.acceptedAt],
    ['Rejected', delivery.rejectedAt],
    ['Picked up', delivery.pickedUpAt],
    ['Delivered', delivery.deliveredAt],
    ['Cancelled', delivery.cancelledAt],
  ];
  return candidates.flatMap(([label, iso]) => (iso ? [{ label, iso }] : []));
}

export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString();
}
