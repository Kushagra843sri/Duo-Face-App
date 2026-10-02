import { FirestoreCustomerAppProductProvider } from '../integrations/customerApp/FirestoreCustomerAppProductProvider';
import type { CustomerAppProductProvider } from '../integrations/customerApp/CustomerAppProductProvider';
import { FirestoreCustomerAppShopProvider } from '../integrations/customerApp/FirestoreCustomerAppShopProvider';
import type { CustomerAppShopProvider } from '../integrations/customerApp/CustomerAppShopProvider';
import { AppError } from '../middleware/errorHandler';
import { InventoryService } from './inventoryService';
import { customerAppProductSnapshotSchema } from '../types/customerAppProduct';
import type { DuoFaceShop } from '../types/duoFaceShop';
import type { MerchantProductCatalogEntry } from '../types/merchantProductCatalog';

export class MerchantProductCatalogService {
  constructor(
    private readonly productProvider: CustomerAppProductProvider = new FirestoreCustomerAppProductProvider(),
    private readonly inventoryService: InventoryService = new InventoryService(),
    private readonly shopProvider: CustomerAppShopProvider = new FirestoreCustomerAppShopProvider()
  ) {}

  /**
   * Joins the Customer App's products — filtered by its own `shopId`
   * field, which references a *Customer App* shop id, NOT the Duo-Face
   * shop's own `shopId` (see docs/decisions/009-merchant-product-catalog-boundary.md)
   * — with this shop's Duo-Face inventory, if any.
   *
   * An unusable link is a 409, never a silent empty list:
   * - no `customerAppShopId` at all → "not linked"
   * - a `customerAppShopId` that no longer resolves to a real Customer App
   *   shop → a distinct "linked shop no longer exists" failure (the link
   *   was valid when provisioned; the target can still disappear later)
   *
   * A malformed Customer App product, or one whose shopId doesn't actually
   * match (defensive — the query already filters, but never trust it
   * blindly), is skipped and logged, not thrown — that's a per-product
   * data-quality concern, not an integration-configuration one. This never
   * creates inventory: a product with none yet shows `inventory: null`.
   */
  async listCatalog(shop: DuoFaceShop): Promise<MerchantProductCatalogEntry[]> {
    if (!shop.customerAppShopId) {
      throw new AppError(409, 'Merchant shop is not linked to a Customer App shop.');
    }

    const linkedShop = await this.shopProvider.getShop(shop.customerAppShopId);
    if (!linkedShop) {
      throw new AppError(
        409,
        `The Customer App shop ${shop.customerAppShopId} linked to this merchant shop no longer exists.`
      );
    }

    const [rawProducts, inventoryItems] = await Promise.all([
      this.productProvider.listProductsByShopId(shop.customerAppShopId),
      this.inventoryService.listInventory(shop.shopId),
    ]);

    const inventoryByProductId = new Map(inventoryItems.map((item) => [item.productId, item]));

    const entries: MerchantProductCatalogEntry[] = [];

    for (const raw of rawProducts) {
      const parsed = customerAppProductSnapshotSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn('MerchantProductCatalogService: skipping malformed Customer App product', parsed.error.issues);
        continue;
      }

      const product = parsed.data;
      if (product.shopId !== shop.customerAppShopId) {
        console.warn(`MerchantProductCatalogService: skipping product ${product.id} with mismatched shopId`);
        continue;
      }

      const inventory = inventoryByProductId.get(product.id);

      entries.push({
        productId: product.id,
        name: product.name,
        price: product.price,
        inStock: product.inStock,
        inventory: inventory
          ? { quantity: inventory.quantity, reservedQuantity: inventory.reservedQuantity, status: inventory.status }
          : null,
      });
    }

    return entries;
  }
}
