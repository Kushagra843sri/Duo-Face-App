import { FirestoreCustomerAppInventoryProvider } from '../integrations/customerApp/FirestoreCustomerAppInventoryProvider';
import type { CustomerAppInventoryProvider } from '../integrations/customerApp/CustomerAppInventoryProvider';
import { FirestoreInventoryStore } from '../integrations/firebase/FirestoreInventoryStore';
import type { InventoryStore } from '../integrations/firebase/FirestoreInventoryStore';
import { AppError } from '../middleware/errorHandler';
import { buildInventoryId, inventoryItemSchema } from '../types/inventoryItem';
import type { InventoryItem } from '../types/inventoryItem';

export class InventoryService {
  constructor(
    private readonly store: InventoryStore = new FirestoreInventoryStore(),
    private readonly productLookup: CustomerAppInventoryProvider = new FirestoreCustomerAppInventoryProvider()
  ) {}

  private parse(raw: Record<string, unknown>, shopId: string, productId: string): InventoryItem {
    const item = inventoryItemSchema.parse(raw);
    if (item.shopId !== shopId || item.productId !== productId) {
      throw new Error(
        `duo_face_inventory/${buildInventoryId(shopId, productId)} has mismatched shopId/productId fields`
      );
    }
    return item;
  }

  async getInventory(shopId: string, productId: string): Promise<InventoryItem | null> {
    const raw = await this.store.get(buildInventoryId(shopId, productId));
    if (!raw) return null;
    return this.parse(raw, shopId, productId);
  }

  async listInventory(shopId: string): Promise<InventoryItem[]> {
    const rawList = await this.store.listByShopId(shopId);
    return rawList.map((raw) => {
      const item = inventoryItemSchema.parse(raw);
      if (item.shopId !== shopId) {
        throw new Error(`duo_face_inventory query for shopId ${shopId} returned a mismatched document`);
      }
      return item;
    });
  }

  async createInventory(shopId: string, productId: string, quantity: number): Promise<InventoryItem> {
    const id = buildInventoryId(shopId, productId);

    const existing = await this.store.get(id);
    if (existing) {
      throw new AppError(409, `Inventory already exists for shop ${shopId} / product ${productId}`);
    }

    const product = await this.productLookup.getProduct(productId);
    if (!product) {
      throw new AppError(404, `Product ${productId} does not exist in the Customer App`);
    }

    const now = new Date();
    const data: Record<string, unknown> = {
      inventoryId: id,
      shopId,
      productId,
      quantity,
      reservedQuantity: 0,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };

    await this.store.set(id, data);
    return inventoryItemSchema.parse(data);
  }

  async setQuantity(shopId: string, productId: string, quantity: number): Promise<InventoryItem> {
    const id = buildInventoryId(shopId, productId);

    const updated = await this.store.runTransaction(id, (current) => {
      if (!current) {
        throw new AppError(404, `Inventory not found for shop ${shopId} / product ${productId}`);
      }
      const item = inventoryItemSchema.parse(current);
      if (item.status !== 'active') {
        throw new AppError(409, 'Cannot modify disabled inventory');
      }
      if (quantity < item.reservedQuantity) {
        throw new AppError(409, 'quantity cannot be set below reservedQuantity');
      }
      return { ...item, quantity, updatedAt: new Date() };
    });

    return inventoryItemSchema.parse(updated);
  }

  async adjustQuantity(shopId: string, productId: string, delta: number): Promise<InventoryItem> {
    const id = buildInventoryId(shopId, productId);

    const updated = await this.store.runTransaction(id, (current) => {
      if (!current) {
        throw new AppError(404, `Inventory not found for shop ${shopId} / product ${productId}`);
      }
      const item = inventoryItemSchema.parse(current);
      if (item.status !== 'active') {
        throw new AppError(409, 'Cannot adjust disabled inventory');
      }

      const newQuantity = item.quantity + delta;
      if (newQuantity < 0) {
        throw new AppError(409, 'quantity cannot become negative');
      }
      if (newQuantity < item.reservedQuantity) {
        throw new AppError(409, 'quantity cannot become less than reservedQuantity');
      }

      return { ...item, quantity: newQuantity, updatedAt: new Date() };
    });

    return inventoryItemSchema.parse(updated);
  }

  async disableInventory(shopId: string, productId: string): Promise<InventoryItem> {
    const id = buildInventoryId(shopId, productId);
    const existing = await this.getInventory(shopId, productId);
    if (!existing) {
      throw new AppError(404, `Inventory not found for shop ${shopId} / product ${productId}`);
    }

    const data: Record<string, unknown> = { ...existing, status: 'disabled', updatedAt: new Date() };
    await this.store.set(id, data);
    return inventoryItemSchema.parse(data);
  }
}
