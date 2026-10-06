import { loadCommissionBps, loadProfileEncryptionKey } from '../config/profile';
import { FirestoreProfileStore } from '../integrations/firebase/FirestoreProfileStore';
import type { ProfileStore } from '../integrations/firebase/FirestoreProfileStore';
import { createObjectStorage } from '../integrations/storage/R2Storage';
import type { ObjectStorage } from '../integrations/storage/R2Storage';
import { AppError } from '../middleware/errorHandler';
import { buildCompleteness, MERCHANT_PROFILES_COLLECTION, reviewNote } from '../types/profile';
import type { MerchantProfileInput, ReviewRecord, VerificationStatus } from '../types/profile';
import { normalizeUpper } from '../validators/indianIds';
import { appEvents } from './appEvents';
import type { AppEvents } from './appEvents';
import { DuoFaceShopService } from './duoFaceShopService';
import { FieldCrypto, lastChars, maskLast } from './fieldCrypto';
import { nextStatus } from './driverProfileService';
import { ProfilePhotoService } from './profilePhotoService';
import type { PhotoTarget } from './profilePhotoService';

interface Address {
  line1: string;
  city: string;
  state?: string;
  pincode: string;
}

/** What is stored. Sensitive values appear ONLY as ciphertext (`*Enc`) or masked strings. */
export interface MerchantProfileDoc {
  shopId: string;
  personal?: { shopName: string; ownerName: string; contactPhone: string; email?: string; address: Address };
  identity?: { panEnc?: string; panMasked?: string; gstin?: string; fssai?: string };
  bank?: { accountHolderName: string; accountEnc?: string; accountLast4?: string; ifsc: string; bankName?: string; upiId?: string };
  photos?: { shopKey?: string };
  kycStatus: VerificationStatus;
  bankStatus: VerificationStatus;
  kycReview?: ReviewRecord;
  bankReview?: ReviewRecord;
  /** Newest last, capped. */
  reviewHistory?: ReviewRecord[];
  commissionBps?: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface MerchantProfileDto {
  personal: MerchantProfileDoc['personal'] | null;
  identity: { panMasked: string | null; gstin: string | null; fssai: string | null };
  bank: { accountHolderName: string; accountMasked: string | null; ifsc: string; bankName: string | null; upiId: string | null } | null;
  pickupLocation: { latitude: number; longitude: number } | null;
  /** Null when the merchant has no photo (the app shows a blank initial, like WhatsApp). */
  photoUrl: string | null;
  kycStatus: VerificationStatus;
  bankStatus: VerificationStatus;
  /** Why the last review rejected this section (only while it is rejected), else null. */
  kycReviewNote: string | null;
  bankReviewNote: string | null;
  payoutReady: boolean;
  commissionBps: number | null;
  completeness: ReturnType<typeof buildCompleteness>;
}

const ctx = (shopId: string, field: string) => `merchant:${shopId}:${field}`;

const personalDone = (p: MerchantProfileDoc['personal']) => Boolean(p?.shopName && p.ownerName && p.contactPhone && p.address?.line1);
const identityDone = (i: MerchantProfileDoc['identity']) => Boolean(i?.panEnc);
const bankDone = (b: MerchantProfileDoc['bank']) => Boolean(b?.accountHolderName && b.accountEnc && b.ifsc);

/**
 * Merchant profile: shop + owner details, PAN/GST, settlement bank details,
 * pickup location and an OPTIONAL photo (docs/decisions/029). `shopId` is
 * always the authenticated merchant's shop.
 */
export class MerchantProfileService implements PhotoTarget {
  readonly photos: ProfilePhotoService;

  constructor(
    private readonly store: ProfileStore = new FirestoreProfileStore(MERCHANT_PROFILES_COLLECTION),
    private readonly shops: DuoFaceShopService = new DuoFaceShopService(),
    private readonly crypto: FieldCrypto | null = (() => {
      const key = loadProfileEncryptionKey();
      return key ? new FieldCrypto(key) : null;
    })(),
    storage: ObjectStorage = createObjectStorage(),
    private readonly commissionBps: number | null = loadCommissionBps(),
    private readonly now: () => Date = () => new Date(),
    private readonly events: AppEvents = appEvents
  ) {
    this.photos = new ProfilePhotoService('merchant', storage, this);
  }

  private async load(shopId: string): Promise<MerchantProfileDoc> {
    const raw = (await this.store.get(shopId)) as MerchantProfileDoc | null;
    if (raw) return raw;
    const at = this.now();
    return { shopId, kycStatus: 'incomplete', bankStatus: 'incomplete', createdAt: at, updatedAt: at, ...(this.commissionBps !== null ? { commissionBps: this.commissionBps } : {}) };
  }

  private requireCrypto(): FieldCrypto {
    if (!this.crypto) throw new AppError(503, 'Secure storage is not configured.');
    return this.crypto;
  }

  async toDto(doc: MerchantProfileDoc): Promise<MerchantProfileDto> {
    const shop = await this.shops.getById(doc.shopId);
    const pickup = shop?.pickupLocation ?? null;
    return {
      personal: doc.personal ?? null,
      identity: { panMasked: doc.identity?.panMasked ?? null, gstin: doc.identity?.gstin ?? null, fssai: doc.identity?.fssai ?? null },
      bank: doc.bank
        ? {
            accountHolderName: doc.bank.accountHolderName,
            accountMasked: doc.bank.accountLast4 ? `••••${doc.bank.accountLast4}` : null,
            ifsc: doc.bank.ifsc,
            bankName: doc.bank.bankName ?? null,
            upiId: doc.bank.upiId ?? null,
          }
        : null,
      pickupLocation: pickup ? { latitude: pickup.latitude, longitude: pickup.longitude } : null,
      photoUrl: this.photos.viewUrl(doc.photos?.shopKey),
      kycStatus: doc.kycStatus,
      bankStatus: doc.bankStatus,
      kycReviewNote: reviewNote(doc.kycStatus, doc.kycReview),
      bankReviewNote: reviewNote(doc.bankStatus, doc.bankReview),
      payoutReady: doc.kycStatus === 'verified' && doc.bankStatus === 'verified' && bankDone(doc.bank),
      commissionBps: doc.commissionBps ?? null,
      completeness: buildCompleteness([
        { key: 'personal', label: 'Shop & owner', done: personalDone(doc.personal) },
        { key: 'identity', label: 'PAN & tax details', done: identityDone(doc.identity) },
        { key: 'bank', label: 'Bank & payouts', done: bankDone(doc.bank) },
        { key: 'location', label: 'Pickup location', done: pickup !== null },
        { key: 'photo', label: 'Photo', done: Boolean(doc.photos?.shopKey), optional: true },
      ]),
    };
  }

  async get(shopId: string): Promise<MerchantProfileDto> {
    return this.toDto(await this.load(shopId));
  }

  async update(shopId: string, input: MerchantProfileInput): Promise<MerchantProfileDto> {
    const doc = await this.load(shopId);
    const before = { kyc: doc.kycStatus, bank: doc.bankStatus };
    let kycChanged = false;
    let bankChanged = false;

    if (input.personal) {
      doc.personal = { ...input.personal, address: { ...input.personal.address } };
      kycChanged = true;
    }

    if (input.identity) {
      const next = { ...(doc.identity ?? {}) };
      if (input.identity.panNumber) {
        const pan = normalizeUpper(input.identity.panNumber);
        next.panEnc = this.requireCrypto().encrypt(pan, ctx(shopId, 'pan'));
        next.panMasked = maskLast(pan);
      }
      if (input.identity.gstin) next.gstin = normalizeUpper(input.identity.gstin);
      if (input.identity.fssai) next.fssai = input.identity.fssai.replace(/\s/g, '');
      doc.identity = next;
      kycChanged = true;
    }

    if (input.bank) {
      const b = input.bank;
      const next: NonNullable<MerchantProfileDoc['bank']> = {
        accountHolderName: b.accountHolderName,
        ifsc: normalizeUpper(b.ifsc),
        ...(b.bankName ? { bankName: b.bankName } : {}),
        ...(b.upiId ? { upiId: b.upiId } : {}),
        ...(doc.bank?.accountEnc ? { accountEnc: doc.bank.accountEnc, accountLast4: doc.bank.accountLast4 } : {}),
      };
      if (b.accountNumber) {
        const account = b.accountNumber.replace(/[\s-]/g, '');
        next.accountEnc = this.requireCrypto().encrypt(account, ctx(shopId, 'bank-account'));
        next.accountLast4 = lastChars(account, 4);
      }
      doc.bank = next;
      bankChanged = true;
    }

    this.recompute(doc, kycChanged, bankChanged);
    doc.updatedAt = this.now();
    await this.store.set(shopId, doc as unknown as Record<string, unknown>);
    // Tell the admins when something newly entered review (not on every edit of a profile already waiting).
    if ((before.kyc !== 'pending_review' && doc.kycStatus === 'pending_review') || (before.bank !== 'pending_review' && doc.bankStatus === 'pending_review')) {
      void this.events.kycSubmitted({ kind: 'merchant', shopId }, String(doc.updatedAt.getTime()));
    }

    // Display fields live on the main shop document.
    if (input.personal) await this.shops.updateName(shopId, input.personal.shopName);
    if (input.pickupLocation) await this.shops.setPickupLocation(shopId, input.pickupLocation);
    return this.toDto(doc);
  }

  private recompute(doc: MerchantProfileDoc, kycChanged: boolean, bankChanged: boolean) {
    doc.kycStatus = nextStatus(doc.kycStatus, personalDone(doc.personal) && identityDone(doc.identity), kycChanged);
    doc.bankStatus = nextStatus(doc.bankStatus, bankDone(doc.bank), bankChanged);
  }

  // ---- PhotoTarget (optional shop/owner photo; not KYC evidence, so it does not affect review) ----
  async getPhotoKey(shopId: string): Promise<string | null> {
    return (await this.load(shopId)).photos?.shopKey ?? null;
  }

  async setPhotoKey(shopId: string, _kind: string, key: string | null): Promise<void> {
    const doc = await this.load(shopId);
    doc.photos = key ? { shopKey: key } : {};
    doc.updatedAt = this.now();
    await this.store.set(shopId, doc as unknown as Record<string, unknown>);
  }

  /** For the future admin tool only. */
  async setVerification(shopId: string, patch: { kycStatus?: VerificationStatus; bankStatus?: VerificationStatus }): Promise<void> {
    const doc = await this.load(shopId);
    if (patch.kycStatus) doc.kycStatus = patch.kycStatus;
    if (patch.bankStatus) doc.bankStatus = patch.bankStatus;
    doc.updatedAt = this.now();
    await this.store.set(shopId, doc as unknown as Record<string, unknown>);
  }

  /** Server-side only (payout job, support). Never exposed over HTTP. */
  readSensitive(doc: MerchantProfileDoc, shopId: string, field: 'pan' | 'bank-account'): string | null {
    const envelope = field === 'pan' ? doc.identity?.panEnc : doc.bank?.accountEnc;
    return envelope ? this.requireCrypto().decrypt(envelope, ctx(shopId, field)) : null;
  }
}
