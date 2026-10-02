/**
 * Read-only lookup against the Customer App's own `shops` collection —
 * used only to verify a `customerAppShopId` supplied at merchant
 * provisioning time genuinely exists, before Duo-Face ever links to it
 * (see docs/decisions/009-merchant-product-catalog-boundary.md).
 */
export interface CustomerAppShopProvider {
  getShop(customerAppShopId: string): Promise<unknown | null>;
}
