import type { DeliveryAssignmentStatus } from './deliveryAssignment';

/**
 * Safe DTO for the /merchant/deliveries endpoints. Timestamps are ISO 8601
 * strings (or null/absent when unset) — never raw Firestore Timestamps.
 * driverName/driverPhoneNumber are joined from the Duo-Face driver profile;
 * driverName is null only if that profile no longer exists. No firebaseUid
 * or other profile data is ever included.
 */
export interface MerchantDeliveryAssignment {
  assignmentId: string;
  orderId: string;
  customerAppShopId: string;
  driverId: string;
  driverName: string | null;
  driverPhoneNumber?: string;
  status: DeliveryAssignmentStatus;
  assignedAt: string | null;
  acceptedAt?: string;
  rejectedAt?: string;
  pickedUpAt?: string;
  deliveredAt?: string;
  cancelledAt?: string;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Latest assignment for an order, embedded in the merchant order DTOs. */
export interface MerchantOrderDeliveryAssignment {
  assignmentId: string;
  status: DeliveryAssignmentStatus;
}
