import { FirestoreCustomerStore } from '../integrations/firebase/FirestoreCustomerStore';
import type { CustomerStore } from '../integrations/firebase/FirestoreCustomerStore';
import { FirestoreInventoryStore } from '../integrations/firebase/FirestoreInventoryStore';
import type { InventoryStore } from '../integrations/firebase/FirestoreInventoryStore';
import { AppError } from '../middleware/errorHandler';
import { buildInventoryId } from '../types/inventoryItem';
import type { CustomerProductView, CustomerShopView } from '../types/customerOrder';
import { rupeesToPaise } from './money';

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** What a customer can browse. Read-only; never exposes merchant/owner or internal fields. */
export class CustomerCatalogService {
  constructor(
    private readonly store: CustomerStore = new FirestoreCustomerStore(),
    private readonly inventory: InventoryStore = new FirestoreInventoryStore()
  ) {}

  async listShops(): Promise<CustomerShopView[]> {
    const shops = await this.store.listShops();
    return shops
      .filter((s) => s.isActive !== false && typeof s.name === 'string' && s.name.length > 0)
      .map((s) => ({
        shopId: String(s.id),
        name: String(s.name),
        address: str(s.address) ?? '',
        imageUrl: str(s.imageUrl),
        rating: typeof s.rating === 'number' ? s.rating : null,
        isOpen: s.isOpen !== false,
      }))
      .sort((a, b) => Number(b.isOpen) - Number(a.isOpen) || a.name.localeCompare(b.name));
  }

  /**
   * A product is orderable only when the merchant has set a quantity for it
   * (Duo-Face inventory), that inventory is active and has stock left, and
   * the Customer App's own `inStock`/`isActive` flags do not say otherwise.
   */
  async listProducts(shopId: string): Promise<CustomerProductView[]> {
    const shop = await this.store.getShop(shopId);
    if (!shop || shop.isActive === false) throw new AppError(404, 'Shop not found');

    const [products, inventoryRows] = await Promise.all([
      this.store.listProductsByShop(shopId),
      this.inventory.listByShopId(shopId),
    ]);
    const stock = new Map(inventoryRows.map((r) => [String(r.inventoryId), r]));

    const views: CustomerProductView[] = [];
    for (const p of products) {
      if (p.isActive === false || p.inStock === false) continue;
      if (typeof p.name !== 'string' || typeof p.id !== 'string') continue;
      const inv = stock.get(buildInventoryId(shopId, p.id));
      if (!inv || inv.status !== 'active') continue;
      const available = Number(inv.quantity) - Number(inv.reservedQuantity ?? 0);
      if (!(available > 0)) continue;
      let pricePaise: number;
      try {
        pricePaise = rupeesToPaise(p.price);
      } catch {
        continue; // malformed price: hide the product rather than show a wrong one
      }
      views.push({
        productId: p.id,
        name: p.name,
        description: str(p.description),
        imageUrl: str(p.imageUrl),
        pricePaise,
        available,
      });
    }
    return views.sort((a, b) => a.name.localeCompare(b.name));
  }
}
