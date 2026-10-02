import { apiRequest } from '@/api/client';
import type { DeliveryOrder } from '@/api/deliveryOrder';

/** Mirrors GET /merchant/me's response (server/src/routes/merchant/index.ts). */
export interface MerchantMe {
  firebaseUid: string;
  role: 'merchant';
  shopId: string;
  shopName: string;
}

/** Mirrors server/src/types/merchantProductCatalog.ts. */
export interface MerchantProductCatalogEntry {
  productId: string;
  name: string;
  price: number;
  inStock: boolean;
  inventory: { quantity: number; reservedQuantity: number; status: 'active' | 'disabled' } | null;
}

/** Mirrors server/src/types/inventoryItem.ts (as serialized over JSON). */
export interface MerchantInventoryItem {
  inventoryId: string;
  shopId: string;
  productId: string;
  quantity: number;
  reservedQuantity: number;
  status: 'active' | 'disabled';
}

/** Mirrors server/src/types/merchantOrder.ts. */
export interface MerchantOrderSummary {
  orderId: string;
  status: string;
  itemCount: number;
  total: number;
  createdAt: string;
  /** Latest Duo-Face delivery assignment for the order (null = none). Resolved server-side. */
  deliveryAssignment?: MerchantOrderDeliveryAssignment | null;
}

/** Mirrors server/src/types/merchantDelivery.ts. */
export type DeliveryAssignmentStatus = 'assigned' | 'accepted' | 'rejected' | 'picked_up' | 'delivered' | 'cancelled';

export interface MerchantOrderDeliveryAssignment {
  assignmentId: string;
  status: DeliveryAssignmentStatus;
}

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

export interface MerchantOrderDetail extends MerchantOrderSummary {
  items: Array<{ productId: string; name: string; quantity: number; price: number; subtotal: number }>;
  delivery: { label: string; fullAddress: string; phoneNumber: string };
  paymentStatus: string;
}

export function getMerchantMe() {
  return apiRequest<MerchantMe>('/merchant/me');
}

export function getMerchantProducts() {
  return apiRequest<MerchantProductCatalogEntry[]>('/merchant/products');
}

export function getMerchantInventory() {
  return apiRequest<MerchantInventoryItem[]>('/merchant/inventory');
}

export function getMerchantInventoryItem(productId: string) {
  return apiRequest<MerchantInventoryItem>(`/merchant/inventory/${encodeURIComponent(productId)}`);
}

export function createMerchantInventory(productId: string, quantity: number) {
  return apiRequest<MerchantInventoryItem>('/merchant/inventory', {
    method: 'POST',
    body: JSON.stringify({ productId, quantity }),
  });
}

export function setMerchantInventoryQuantity(productId: string, quantity: number) {
  return apiRequest<MerchantInventoryItem>(`/merchant/inventory/${encodeURIComponent(productId)}/quantity`, {
    method: 'PATCH',
    body: JSON.stringify({ quantity }),
  });
}

export function adjustMerchantInventory(productId: string, delta: number) {
  return apiRequest<MerchantInventoryItem>(`/merchant/inventory/${encodeURIComponent(productId)}/adjust`, {
    method: 'POST',
    body: JSON.stringify({ delta }),
  });
}

export function disableMerchantInventory(productId: string) {
  return apiRequest<MerchantInventoryItem>(`/merchant/inventory/${encodeURIComponent(productId)}/disable`, {
    method: 'PATCH',
  });
}

export function getMerchantOrders() {
  return apiRequest<MerchantOrderSummary[]>('/merchant/orders');
}

export function getMerchantOrder(orderId: string) {
  return apiRequest<MerchantOrderDetail>(`/merchant/orders/${encodeURIComponent(orderId)}`);
}

export function getMerchantDeliveries() {
  return apiRequest<MerchantDeliveryAssignment[]>('/merchant/deliveries');
}

export function getMerchantDelivery(assignmentId: string) {
  return apiRequest<MerchantDeliveryAssignment>(`/merchant/deliveries/${encodeURIComponent(assignmentId)}`);
}

export function getMerchantDeliveryOrder(assignmentId: string) {
  return apiRequest<DeliveryOrder>(`/merchant/deliveries/${encodeURIComponent(assignmentId)}/order`);
}

/**
 * Raises a driver request for an order. The merchant never picks a driver:
 * the server assigns the nearest eligible one (docs/decisions/026) and
 * answers 409 when none is available. No shopId/customerAppShopId either —
 * the backend derives shop ownership from the authenticated merchant.
 */
export function requestMerchantDriver(orderId: string) {
  return apiRequest<MerchantDeliveryAssignment>('/merchant/deliveries', {
    method: 'POST',
    body: JSON.stringify({ orderId }),
  });
}
