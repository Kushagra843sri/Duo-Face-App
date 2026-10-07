/**
 * Safe, minimum operational view of a Customer App order, reachable only
 * through a valid Duo-Face delivery assignment. Deliberately excludes
 * customerId, payment fields/IDs, per-item prices and productIds, order
 * status, and any Firestore metadata.
 */
export interface DeliveryOrder {
  assignmentId: string;
  orderId: string;
  /** Customer App shop name; omitted if the shop can't be read (non-fatal). */
  shopName?: string;
  /** phoneNumber is merchant-only: a driver never receives it (docs/decisions/028). */
  delivery: { label: string; fullAddress: string; phoneNumber?: string };
  /**
   * Driver endpoint only, and only when a geocoder resolved the address.
   * Absent otherwise — coordinates are never guessed (docs/decisions/020).
   */
  destination?: { latitude: number; longitude: number };
  items: Array<{ name: string; quantity: number }>;
  itemCount: number;
  total: number; // as stored by the Customer App: float rupees (decision 003)
}
