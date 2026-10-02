import { z } from 'zod';

/**
 * duo_face_delivery_destinations/{addressHash}: geocoded coordinates for a
 * normalized delivery address. Keyed by the address, not the order.
 * Deliberately no customerId, phone, payment, Firebase UID, driverId,
 * assignmentId or order data.
 */
export const deliveryDestinationSchema = z.object({
  destinationId: z.string().min(1),
  addressHash: z.string().min(1),
  normalizedAddress: z.string().min(1),
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  provider: z.string().min(1),
  precision: z.number().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
});

export type DeliveryDestination = z.infer<typeof deliveryDestinationSchema>;
