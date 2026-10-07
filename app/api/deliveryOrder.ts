/**
 * Mirrors server/src/types/deliveryOrder.ts: the minimum operational view
 * of a Customer App order, served only through a delivery assignment
 * (GET /driver/assignments/:id/order, GET /merchant/deliveries/:id/order).
 */
export interface DeliveryOrder {
  assignmentId: string;
  orderId: string;
  shopName?: string;
  /** phoneNumber is merchant-only: a driver never receives it (docs/decisions/028). */
  delivery: { label: string; fullAddress: string; phoneNumber?: string };
  /** Driver endpoint only; absent when the server could not geocode the address (geocoding is server-side, docs/decisions/021). */
  destination?: { latitude: number; longitude: number };
  items: Array<{ name: string; quantity: number }>;
  itemCount: number;
  total: number;
}
