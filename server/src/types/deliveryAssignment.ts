import { z } from 'zod';

/**
 * Duo-Face-owned delivery assignment — links a Customer App order to a
 * driver. These statuses are entirely separate from the Customer App
 * order's own `status` field and are never written into it — see
 * docs/decisions/013-driver-and-delivery-assignment.md.
 */
export const deliveryAssignmentStatusSchema = z.enum([
  'assigned',
  'accepted',
  'rejected',
  'picked_up',
  'delivered',
  'cancelled',
]);
export type DeliveryAssignmentStatus = z.infer<typeof deliveryAssignmentStatusSchema>;

export const deliveryAssignmentSchema = z.object({
  assignmentId: z.string().min(1),
  orderId: z.string().min(1),
  customerAppShopId: z.string().min(1),
  driverId: z.string().min(1),
  status: deliveryAssignmentStatusSchema,
  assignedAt: z.unknown(),
  acceptedAt: z.unknown().optional(),
  rejectedAt: z.unknown().optional(),
  pickedUpAt: z.unknown().optional(),
  deliveredAt: z.unknown().optional(),
  cancelledAt: z.unknown().optional(),
  // Delivery-code fallback (docs/decisions/028). Hash only — the plaintext is
  // never stored — and never part of any DTO.
  deliveryOtpHash: z.string().min(1).optional(),
  deliveryOtpAttempts: z.number().int().min(0).optional(),
  deliveryOtpLockedAt: z.unknown().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
});

export type DeliveryAssignment = z.infer<typeof deliveryAssignmentSchema>;
