import { FirestoreDuoFaceShopStore } from '../integrations/firebase/FirestoreDuoFaceShopStore';
import type { DuoFaceShopStore } from '../integrations/firebase/FirestoreDuoFaceShopStore';
import { duoFaceShopSchema, pickupLocationSchema } from '../types/duoFaceShop';
import type { DuoFaceShop, PickupLocation } from '../types/duoFaceShop';

export interface CreateShopInput {
  shopId: string;
  name: string;
  merchantFirebaseUid: string;
}

export class DuoFaceShopService {
  constructor(private readonly store: DuoFaceShopStore = new FirestoreDuoFaceShopStore()) {}

  /**
   * Throws (never silently repairs) on a malformed stored document — an
   * unsupported status, a missing field, or a shopId field that doesn't
   * match the document it was read from.
   */
  async getById(shopId: string): Promise<DuoFaceShop | null> {
    const raw = await this.store.get(shopId);
    if (!raw) return null;

    const shop = duoFaceShopSchema.parse(raw);
    if (shop.shopId !== shopId) {
      throw new Error(`duo_face_shops/${shopId} has a mismatched shopId field`);
    }

    return shop;
  }

  async getByMerchantFirebaseUid(merchantFirebaseUid: string): Promise<DuoFaceShop | null> {
    const raw = await this.store.findByMerchantFirebaseUid(merchantFirebaseUid);
    if (!raw) return null;

    const shop = duoFaceShopSchema.parse(raw);
    if (shop.merchantFirebaseUid !== merchantFirebaseUid) {
      throw new Error(`duo_face_shops query for merchantFirebaseUid ${merchantFirebaseUid} returned a mismatched document`);
    }

    return shop;
  }

  async getByCustomerAppShopId(customerAppShopId: string): Promise<DuoFaceShop | null> {
    const raw = await this.store.findByCustomerAppShopId(customerAppShopId);
    if (!raw) return null;

    const shop = duoFaceShopSchema.parse(raw);
    if (shop.customerAppShopId !== customerAppShopId) {
      throw new Error(`duo_face_shops query for customerAppShopId ${customerAppShopId} returned a mismatched document`);
    }

    return shop;
  }

  /** Updates only the display name. Throws if the shop does not exist. */
  async updateName(shopId: string, name: string): Promise<DuoFaceShop> {
    const existing = await this.getById(shopId);
    if (!existing) {
      throw new Error(`Cannot rename duo_face_shops/${shopId}: no such shop exists`);
    }

    const data: Record<string, unknown> = { ...existing, name, updatedAt: new Date() };
    await this.store.set(shopId, data);
    return duoFaceShopSchema.parse(data);
  }

  /**
   * Sets (or corrects) where drivers collect this shop's orders. Validated;
   * changes only pickupLocation + updatedAt. Throws if the shop doesn't exist.
   */
  async setPickupLocation(shopId: string, location: PickupLocation): Promise<DuoFaceShop> {
    const pickupLocation = pickupLocationSchema.parse(location);
    const existing = await this.getById(shopId);
    if (!existing) {
      throw new Error(`Cannot set pickupLocation on duo_face_shops/${shopId}: no such shop exists`);
    }

    const data: Record<string, unknown> = { ...existing, pickupLocation, updatedAt: new Date() };
    await this.store.set(shopId, data);
    return duoFaceShopSchema.parse(data);
  }

  /**
   * Direct, single-collection write — used internally by
   * MerchantProvisioningService's atomic transaction path, and available
   * on its own. Overwrites whatever exists at shopId; rejecting a genuine
   * duplicate shopId at provisioning time is MerchantProvisioningService's
   * job (it checks getById() before ever calling this), not this method's.
   */
  async createShop(input: CreateShopInput): Promise<DuoFaceShop> {
    const now = new Date();
    const data: Record<string, unknown> = {
      shopId: input.shopId,
      name: input.name,
      status: 'active',
      merchantFirebaseUid: input.merchantFirebaseUid,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.set(input.shopId, data);
    return duoFaceShopSchema.parse(data);
  }

  /**
   * Throws if the shop doesn't exist — suspending a nonexistent shop is an
   * error, not a silent no-op.
   */
  async suspendShop(shopId: string): Promise<DuoFaceShop> {
    const existing = await this.getById(shopId);
    if (!existing) {
      throw new Error(`Cannot suspend duo_face_shops/${shopId}: no such shop exists`);
    }

    const data: Record<string, unknown> = {
      ...existing,
      status: 'suspended',
      updatedAt: new Date(),
    };

    await this.store.set(shopId, data);
    return duoFaceShopSchema.parse(data);
  }
}
