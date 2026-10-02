/**
 * Reads the Customer App's own product catalog, scoped to a shop. Confirmed
 * from source (customer_app/lib/features/products/models/product.dart,
 * tools/seed_commerce/seed.js): `products.shopId` is a real field
 * referencing the Customer App's `shops/{shopId}` collection — this is the
 * only confirmed products<->shops relationship, and this interface exists
 * only to read it, never to write it.
 */
export interface CustomerAppProductProvider {
  listProductsByShopId(shopId: string): Promise<unknown[]>;
}
