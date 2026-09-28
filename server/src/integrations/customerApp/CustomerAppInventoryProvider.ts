/**
 * Reads and atomically updates stock levels owned by the Customer App.
 * Product/stock model and atomic-update mechanics are unconfirmed — see
 * docs/integration/CUSTOMER_APP_REQUIREMENTS.md (Inventory).
 */
export interface CustomerAppInventoryProvider {
  getStock(itemId: string): Promise<number | null>;
}
