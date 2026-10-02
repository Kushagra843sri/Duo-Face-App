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
  price: number;
  inStock: boolean;
  inventory: {
    quantity: number;
    reservedQuantity: number;
    status: InventoryStatus;
  } | null;
}
