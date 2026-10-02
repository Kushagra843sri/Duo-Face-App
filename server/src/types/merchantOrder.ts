import type { OrderFulfillmentStatus } from './customerAppOrder';
import type { MerchantOrderDeliveryAssignment } from './merchantDelivery';

/**
 * Safe DTOs for GET /merchant/orders and GET /merchant/orders/:orderId —
 * never the raw Customer App order document. customerId, paymentOrderId,
 * paymentId, paymentMethod, paidAt, cancelledAt and cancellationReason are
 * never exposed.
 */
export interface MerchantOrderSummary {
  orderId: string;
  status: OrderFulfillmentStatus;
  itemCount: number;
  total: number; // as stored by the Customer App — still a float in rupees, per decision 003
  createdAt: string; // ISO 8601
  /** Latest Duo-Face delivery assignment for this order, or null if none. Set by the orders route, not MerchantOrderService. */
  deliveryAssignment?: MerchantOrderDeliveryAssignment | null;
}

export interface MerchantOrderDetail extends MerchantOrderSummary {
  items: Array<{ productId: string; name: string; quantity: number; price: number; subtotal: number }>;
  delivery: { label: string; fullAddress: string; phoneNumber: string };
  paymentStatus: string;
}
