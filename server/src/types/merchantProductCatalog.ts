import type { InventoryStatus } from './inventoryItem';

/**
 * Safe DTO returned by GET /merchant/products — never the raw Customer App
 * product document or the raw Duo-Face inventory document. `inventory` is
 * null when no Duo-Face inventory record exists yet for this product
 * (inventory is never auto-created by this endpoint).
 */
export interface MerchantProductCatalogEntry {
  productId: string;
  name: string;
  /** Shown to customers under the name; null when the owner wrote none. */
  description: string | null;
  price: number;
  inStock: boolean;
  /** false = the owner has hidden it from customers. */
  isActive: boolean;
  inventory: {
    quantity: number;
    reservedQuantity: number;
    status: InventoryStatus;
  } | null;
}
