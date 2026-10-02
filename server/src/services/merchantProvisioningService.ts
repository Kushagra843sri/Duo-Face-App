import { z } from 'zod';

import { getFirebaseAdminApp } from '../integrations/firebase/firebaseAdmin';
import { FirestoreCustomerAppShopProvider } from '../integrations/customerApp/FirestoreCustomerAppShopProvider';
import type { CustomerAppShopProvider } from '../integrations/customerApp/CustomerAppShopProvider';
import { createDeliveryGeocoder } from '../integrations/geocoding/createDeliveryGeocoder';
import type { DeliveryGeocoder } from '../integrations/geocoding/DeliveryGeocoder';
import { DuoFaceIdentityService } from './duoFaceIdentityService';
import { DuoFaceShopService } from './duoFaceShopService';
import { customerAppShopSnapshotSchema } from '../types/customerAppShop';
import { duoFaceIdentitySchema } from '../types/duoFaceIdentity';
import type { DuoFaceIdentity } from '../types/duoFaceIdentity';
import { duoFaceShopSchema, pickupLocationSchema } from '../types/duoFaceShop';
import type { PickupLocation } from '../types/duoFaceShop';
import type { DuoFaceShop } from '../types/duoFaceShop';

const provisionMerchantShopInputSchema = z.object({
  firebaseUid: z.string().min(1),
  shopId: z.string().min(1),
  name: z.string().min(1),
  // Optional: nullable until a provisioning flow supplies and validates
  // one (see docs/decisions/009-merchant-product-catalog-boundary.md).
  customerAppShopId: z.string().min(1).optional(),
  // Optional explicit pickup point (exact, wins over geocoding). If omitted
  // and a Customer App shop is linked, its address is geocoded once here.
  pickupLocation: pickupLocationSchema.optional(),
});

export type ProvisionMerchantShopInput = z.infer<typeof provisionMerchantShopInputSchema>;

interface AtomicWrite {
  identityFirebaseUid: string;
  identityData: Record<string, unknown>;
  shopId: string;
  shopData: Record<string, unknown>;
}

/**
 * Narrow, purpose-built transactional seam — not a generic "any two
 * writes" primitive. Real implementation runs one Firestore transaction
 * writing both documents so the identity/shop relationship can never be
 * partially created. Colocated here since nothing else uses it.
 */
export interface DuoFaceProvisioningTransaction {
  runAtomic(write: AtomicWrite): Promise<void>;
}

export class FirestoreDuoFaceProvisioningTransaction implements DuoFaceProvisioningTransaction {
  async runAtomic({ identityFirebaseUid, identityData, shopId, shopData }: AtomicWrite): Promise<void> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());

    await db.runTransaction(async (tx) => {
      tx.set(db.collection('duo_face_identities').doc(identityFirebaseUid), identityData);
      tx.set(db.collection('duo_face_shops').doc(shopId), shopData);
    });
  }
}

export interface ProvisionMerchantShopResult {
  identity: DuoFaceIdentity;
  shop: DuoFaceShop;
}

export class MerchantProvisioningService {
  constructor(
    private readonly identityService: DuoFaceIdentityService = new DuoFaceIdentityService(),
    private readonly shopService: DuoFaceShopService = new DuoFaceShopService(),
    private readonly transaction: DuoFaceProvisioningTransaction = new FirestoreDuoFaceProvisioningTransaction(),
    private readonly customerAppShopProvider: CustomerAppShopProvider = new FirestoreCustomerAppShopProvider(),
    private readonly geocoder: DeliveryGeocoder = createDeliveryGeocoder()
  ) {}

  /**
   * The Customer App shop's text address -> coordinates, via the cached
   * geocoder. Null when there is no address, no geocoder, or no match —
   * never guessed, and the address is never logged.
   */
  private async geocodeShopAddress(rawShop: unknown): Promise<PickupLocation | null> {
    try {
      const address = (rawShop as { address?: unknown } | null)?.address;
      if (typeof address !== 'string' || address.trim().length === 0) return null;
      const parsed = pickupLocationSchema.safeParse(await this.geocoder.geocode(address));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * For shops provisioned before pickup locations existed (or whose location
   * is missing): geocode the linked Customer App shop's address, store it on
   * the Duo-Face shop and return it. Null (nothing stored) if it can't be resolved.
   */
  async backfillPickupLocation(shopId: string): Promise<PickupLocation | null> {
    const shop = await this.shopService.getById(shopId);
    if (!shop) throw new Error(`Cannot backfill: no shop exists at shopId ${shopId}`);
    if (!shop.customerAppShopId) return null;
    const location = await this.geocodeShopAddress(await this.customerAppShopProvider.getShop(shop.customerAppShopId));
    if (!location) return null;
    await this.shopService.setPickupLocation(shopId, location);
    return location;
  }

  /**
   * Not called from any route — a domain operation only (see
   * docs/decisions/006-duo-face-identity-model.md,
   * docs/decisions/007-merchant-shop-boundary.md). Create-only: rejects
   * rather than repairs any pre-existing, inconsistent state.
   */
  async provisionMerchantShop(input: ProvisionMerchantShopInput): Promise<ProvisionMerchantShopResult> {
    const parsed = provisionMerchantShopInputSchema.parse(input);

    const existingIdentity = await this.identityService.getByFirebaseUid(parsed.firebaseUid);
    if (existingIdentity) {
      throw new Error(`Cannot provision: an identity already exists for firebaseUid ${parsed.firebaseUid}`);
    }

    const existingShop = await this.shopService.getById(parsed.shopId);
    if (existingShop) {
      throw new Error(`Cannot provision: a shop already exists at shopId ${parsed.shopId}`);
    }

    const existingShopForMerchant = await this.shopService.getByMerchantFirebaseUid(parsed.firebaseUid);
    if (existingShopForMerchant) {
      throw new Error(
        `Cannot provision: shop ${existingShopForMerchant.shopId} already references merchantFirebaseUid ${parsed.firebaseUid} with no matching identity`
      );
    }

    // Do NOT assume customerShopId === duoFaceShopId. If a Customer App
    // shop id is supplied, verify it against the real collection and
    // reject rather than repair a missing/malformed one — never store an
    // unverified id.
    let customerAppShopId: string | undefined;
    let pickupLocation: PickupLocation | undefined = parsed.pickupLocation;
    if (parsed.customerAppShopId) {
      const rawShop = await this.customerAppShopProvider.getShop(parsed.customerAppShopId);
      if (!rawShop) {
        throw new Error(`Cannot provision: no Customer App shop exists at customerAppShopId ${parsed.customerAppShopId}`);
      }
      const parsedShop = customerAppShopSnapshotSchema.safeParse(rawShop);
      if (!parsedShop.success) {
        throw new Error(`Cannot provision: Customer App shop ${parsed.customerAppShopId} is malformed`);
      }
      customerAppShopId = parsed.customerAppShopId;
      // Resolve the pickup point once, at setup (non-fatal if it can't be found).
      if (!pickupLocation) pickupLocation = (await this.geocodeShopAddress(rawShop)) ?? undefined;
    }

    const now = new Date();

    const identityData: Record<string, unknown> = {
      firebaseUid: parsed.firebaseUid,
      role: 'merchant',
      status: 'active',
      merchant: { shopId: parsed.shopId },
      createdAt: now,
      updatedAt: now,
    };

    const shopData: Record<string, unknown> = {
      shopId: parsed.shopId,
      name: parsed.name,
      status: 'active',
      merchantFirebaseUid: parsed.firebaseUid,
      ...(customerAppShopId ? { customerAppShopId } : {}),
      ...(pickupLocation ? { pickupLocation } : {}),
      createdAt: now,
      updatedAt: now,
    };

    await this.transaction.runAtomic({
      identityFirebaseUid: parsed.firebaseUid,
      identityData,
      shopId: parsed.shopId,
      shopData,
    });

    return {
      identity: duoFaceIdentitySchema.parse(identityData),
      shop: duoFaceShopSchema.parse(shopData),
    };
  }
}
