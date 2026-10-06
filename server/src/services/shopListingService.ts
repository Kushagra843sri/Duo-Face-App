import { FirestoreShopListingStore } from '../integrations/firebase/FirestoreShopListingStore';
import type { ShopListingStore } from '../integrations/firebase/FirestoreShopListingStore';
import { AppError } from '../middleware/errorHandler';

export interface ShopListingView {
  /** False when the shop has no customer-visible record (it cannot be opened or bought from). */
  listed: boolean;
  isOpen: boolean;
}

/** What a brand-new shop looks like to customers: listed, but CLOSED until its owner opens it. */
export function newListingData(name: string, now: Date): Record<string, unknown> {
  return { name, address: '', imageUrl: '', isOpen: false, isActive: true, createdAt: now, updatedAt: now };
}

export interface ShopListingSync {
  /** Keeps the customer-facing name/address in line with the owner's profile. Never throws. */
  syncDetails(customerShopId: string, details: { name?: string; address?: string }): Promise<void>;
}

export class NoopShopListingSync implements ShopListingSync {
  async syncDetails(): Promise<void> {}
}

/** Delegating holder: a no-op until the real server installs the Firestore-backed implementation (tests send nothing). */
export class ShopListingHub implements ShopListingSync {
  private delegate: ShopListingSync = new NoopShopListingSync();
  install(delegate: ShopListingSync): void {
    this.delegate = delegate;
  }
  syncDetails(customerShopId: string, details: { name?: string; address?: string }): Promise<void> {
    try {
      return this.delegate.syncDetails(customerShopId, details).catch(() => undefined);
    } catch {
      return Promise.resolve();
    }
  }
}

export const shopListingHub = new ShopListingHub();

/**
 * The owner's control over how their shop appears to customers: open or
 * closed, and name/address kept in step with the profile. A closed shop stays
 * visible (marked Closed) but cannot be ordered from.
 */
export class ShopListingService implements ShopListingSync {
  constructor(
    private readonly store: ShopListingStore = new FirestoreShopListingStore(),
    private readonly now: () => Date = () => new Date()
  ) {}

  async get(customerShopId: string | undefined): Promise<ShopListingView> {
    if (!customerShopId) return { listed: false, isOpen: false };
    const listing = await this.store.get(customerShopId);
    return listing ? { listed: true, isOpen: listing.isOpen === true } : { listed: false, isOpen: false };
  }

  async setOpen(customerShopId: string | undefined, isOpen: boolean): Promise<ShopListingView> {
    if (!customerShopId || !(await this.store.get(customerShopId))) {
      throw new AppError(409, 'This shop is not listed for customers yet.');
    }
    await this.store.merge(customerShopId, { isOpen, updatedAt: this.now() });
    return { listed: true, isOpen };
  }

  async syncDetails(customerShopId: string, details: { name?: string; address?: string }): Promise<void> {
    try {
      if (!(await this.store.get(customerShopId))) return;
      await this.store.merge(customerShopId, {
        ...(details.name ? { name: details.name } : {}),
        ...(details.address ? { address: details.address } : {}),
        updatedAt: this.now(),
      });
    } catch {
      console.warn(`ShopListingService: could not update the listing for shop ${customerShopId}`);
    }
  }
}
