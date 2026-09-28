/**
 * Reads products/stock and atomically updates stock levels owned by the
 * Customer App. Product model and atomic-update mechanics are unconfirmed —
 * see docs/integration/CUSTOMER_APP_REQUIREMENTS.md (Product/Inventory Model).
 * `getProduct` returns `unknown` deliberately: no field of a product record
 * is confirmed yet, so no shape is guessed here. `adjustStock`'s atomicity is
 * the future adapter's responsibility, not something this signature encodes.
 */
export interface CustomerAppInventoryProvider {
  getProduct(itemId: string): Promise<unknown | null>;
  getStock(itemId: string): Promise<number | null>;
  adjustStock(itemId: string, delta: number): Promise<number>;
}
