import { randomUUID } from 'node:crypto';

import { FirestoreCustomerStore } from '../integrations/firebase/FirestoreCustomerStore';
import type { CustomerStore } from '../integrations/firebase/FirestoreCustomerStore';
import { AppError } from '../middleware/errorHandler';
import { stockKey } from '../types/duoFaceShop';
import type { DuoFaceShop } from '../types/duoFaceShop';
import { buildInventoryId } from '../types/inventoryItem';
import type { MerchantProductCatalogEntry } from '../types/merchantProductCatalog';
import type { CreateProductBody, UpdateProductBody } from '../types/merchantProduct';
import { paiseToRupees, rupeesToPaise } from './money';

type Doc = Record<string, unknown>;

/**
 * A shop owner creating and editing their own products. A product is stored
 * once (`products/{id}`, carrying the customer-facing shop id) and sold
 * according to its stock record, so creating one writes BOTH in a single
 * transaction: there is never a product without stock or stock without a
 * product. Prices are stored the way the rest of the catalog stores them
 * (rupees, exact to two decimals) and handled as integer paise in code.
 * Everything is scoped to `shop`; another shop's product is a 404.
 */
export class MerchantProductService {
  constructor(
    private readonly store: CustomerStore = new FirestoreCustomerStore(),
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = randomUUID
  ) {}

  private requireListed(shop: DuoFaceShop): string {
    if (!shop.customerAppShopId) throw new AppError(409, 'This shop is not listed for customers yet, so it cannot have products.');
    return shop.customerAppShopId;
  }

  async create(shop: DuoFaceShop, body: CreateProductBody): Promise<MerchantProductCatalogEntry> {
    const shopKey = this.requireListed(shop);
    const productId = this.newId();
    const inventoryId = buildInventoryId(stockKey(shop), productId);
    const at = this.now();

    const product: Doc = {
      shopId: shopKey,
      name: body.name,
      description: body.description ?? '',
      price: paiseToRupees(body.pricePaise),
      imageUrl: '',
      inStock: true,
      isActive: true,
      createdAt: at,
      updatedAt: at,
    };
    const inventory: Doc = {
      inventoryId,
      shopId: stockKey(shop),
      productId,
      quantity: body.quantity,
      reservedQuantity: 0,
      status: 'active',
      createdAt: at,
      updatedAt: at,
    };

    await this.store.runTransaction(async (tx) => {
      tx.set('products', productId, product);
      tx.set('duo_face_inventory', inventoryId, inventory);
    });
    return this.toEntry(productId, product, inventory);
  }

  async update(shop: DuoFaceShop, productId: string, patch: UpdateProductBody): Promise<MerchantProductCatalogEntry> {
    const shopKey = this.requireListed(shop);
    const inventoryId = buildInventoryId(stockKey(shop), productId);

    return this.store.runTransaction(async (tx) => {
      const product = await tx.get('products', productId);
      // Missing and another shop's product are indistinguishable.
      if (!product || product.shopId !== shopKey) throw new AppError(404, 'Product not found.');
      const inventory = await tx.get('duo_face_inventory', inventoryId);

      const next: Doc = {
        ...product,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.pricePaise !== undefined ? { price: paiseToRupees(patch.pricePaise) } : {}),
        ...(patch.isAvailable !== undefined ? { isActive: patch.isAvailable } : {}),
        updatedAt: this.now(),
      };
      tx.set('products', productId, next);
      return this.toEntry(productId, next, inventory);
    });
  }

  private toEntry(productId: string, product: Doc, inventory: Doc | null): MerchantProductCatalogEntry {
    return {
      productId,
      name: String(product.name),
      description: typeof product.description === 'string' && product.description ? product.description : null,
      // rupeesToPaise validates; the catalog keeps the rupee figure it always had.
      price: paiseToRupees(rupeesToPaise(product.price)),
      inStock: product.inStock !== false,
      isActive: product.isActive !== false,
      inventory: inventory
        ? { quantity: Number(inventory.quantity), reservedQuantity: Number(inventory.reservedQuantity ?? 0), status: inventory.status === 'disabled' ? 'disabled' : 'active' }
        : null,
    };
  }
}
