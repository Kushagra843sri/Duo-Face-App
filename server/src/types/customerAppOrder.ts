import { z } from 'zod';

/**
 * Confirmed from source (functions/src/types/order.types.ts). Only
 * `pending` and `cancelled` are ever actually written anywhere in the
 * Customer App today — the rest of the enum is declared but unused (see
 * docs/decisions/011-merchant-order-boundary.md) — still accepted here
 * since a real order document's `status` type is this full union.
 */
export const orderFulfillmentStatusSchema = z.enum([
  'pending',
  'confirmed',
  'preparing',
  'ready_for_pickup',
  'out_for_delivery',
  'delivered',
  'cancelled',
  'rejected',
]);
export type OrderFulfillmentStatus = z.infer<typeof orderFulfillmentStatusSchema>;

const orderItemSchema = z.object({
  productId: z.string().min(1),
  name: z.string().min(1),
  price: z.number(),
  quantity: z.number(),
  subtotal: z.number(),
});

/**
 * Only the fields the merchant order endpoints actually need — not the
 * full `OrderDocument` (customerId, paymentOrderId, paymentId,
 * paymentMethod, paidAt, cancelledAt, cancellationReason are intentionally
 * omitted; none of those are exposed to a merchant by this phase).
 */
export const customerAppOrderSnapshotSchema = z.object({
  orderId: z.string().min(1),
  shopId: z.string().min(1),
  status: orderFulfillmentStatusSchema,
  paymentStatus: z.string(),
  items: z.array(orderItemSchema),
  delivery: z.object({
    label: z.string(),
    fullAddress: z.string(),
    phoneNumber: z.string(),
    // The GPS point the customer saved with the address (optional).
    latitude: z.number().optional(),
    longitude: z.number().optional(),
  }),
  pricing: z.object({
    total: z.number(),
  }),
  createdAt: z.unknown(),
});

/**
 * The only fields the CUSTOMER tracking boundary reads from an order:
 * ownership (`customerId`, verified against the caller's Firebase UID),
 * the shop it belongs to, and the address text (used only to look up the
 * destination). Everything else stays unread. Read-only.
 */
export const customerAppOrderOwnershipSchema = z.object({
  orderId: z.string().min(1),
  shopId: z.string().min(1),
  customerId: z.string().min(1),
  delivery: z.object({ fullAddress: z.string(), latitude: z.number().optional(), longitude: z.number().optional() }),
});

export type CustomerAppOrderOwnership = z.infer<typeof customerAppOrderOwnershipSchema>;

export type CustomerAppOrderSnapshot = z.infer<typeof customerAppOrderSnapshotSchema>;
