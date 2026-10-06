import { loadCommissionBps, loadProfileEncryptionKey } from '../config/profile';
import { FirestoreProfileStore } from '../integrations/firebase/FirestoreProfileStore';
import type { ProfileStore } from '../integrations/firebase/FirestoreProfileStore';
import { createObjectStorage } from '../integrations/storage/R2Storage';
import type { ObjectStorage } from '../integrations/storage/R2Storage';
import { AppError } from '../middleware/errorHandler';
import { buildCompleteness, DRIVER_PROFILES_COLLECTION, reviewNote } from '../types/profile';
import type { DriverProfileInput, ReviewRecord, VerificationStatus } from '../types/profile';
import { normalizeAadhaar, normalizeUpper } from '../validators/indianIds';
import { appEvents } from './appEvents';
import type { AppEvents } from './appEvents';
import { DriverService } from './driverService';
import { FieldCrypto, lastChars, maskLast } from './fieldCrypto';
import { ProfilePhotoService } from './profilePhotoService';
import type { PhotoTarget } from './profilePhotoService';

interface Address {
  line1: string;
  city: string;
  state?: string;
  pincode: string;
}

/** What is stored. Sensitive values appear ONLY as ciphertext (`*Enc`) or last-4 / masked strings. */
export interface DriverProfileDoc {
  driverId: string;
  personal?: { fullName: string; contactPhone: string; dateOfBirth: string; address: Address; emergencyContact: { name: string; phone: string } };
  identity?: {
    aadhaarLast4?: string;
    panEnc?: string;
    panMasked?: string;
    licenceEnc?: string;
    licenceMasked?: string;
    licenceExpiry?: string;
  };
  vehicle?: { type: string; registrationNumber: string; makeModel?: string };
  bank?: { accountHolderName: string; accountEnc?: string; accountLast4?: string; ifsc: string; bankName?: string; upiId?: string };
  photos?: { selfieKey?: string; vehicleKey?: string; selfieCapturedAt?: Date; vehicleCapturedAt?: Date };
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

/** Everything the app gets back. No full Aadhaar/PAN/licence/account number ever appears here. */
export interface DriverProfileDto {
  personal: DriverProfileDoc['personal'] | null;
  identity: { aadhaarMasked: string | null; panMasked: string | null; licenceMasked: string | null; licenceExpiry: string | null };
  vehicle: DriverProfileDoc['vehicle'] | null;
  bank: { accountHolderName: string; accountMasked: string | null; ifsc: string; bankName: string | null; upiId: string | null } | null;
  photos: { selfieUrl: string | null; vehicleUrl: string | null };
  kycStatus: VerificationStatus;
  bankStatus: VerificationStatus;
  /** Why the last review rejected this section (only while it is rejected), else null. */
  kycReviewNote: string | null;
  bankReviewNote: string | null;
  payoutReady: boolean;
  /** Platform commission (basis points), read-only. Null until configured. */
  commissionBps: number | null;
  completeness: ReturnType<typeof buildCompleteness>;
}

const ctx = (driverId: string, field: string) => `driver:${driverId}:${field}`;

function personalDone(p: DriverProfileDoc['personal']): boolean {
  return Boolean(p?.fullName && p.contactPhone && p.dateOfBirth && p.address?.line1 && p.emergencyContact?.name);
}
function identityDone(i: DriverProfileDoc['identity']): boolean {
  return Boolean(i?.aadhaarLast4 && i.panEnc && i.licenceEnc && i.licenceExpiry);
}
function vehicleDone(v: DriverProfileDoc['vehicle']): boolean {
  return Boolean(v?.type && v.registrationNumber);
}
function bankDone(b: DriverProfileDoc['bank']): boolean {
  return Boolean(b?.accountHolderName && b.accountEnc && b.ifsc);
}
function photosDone(p: DriverProfileDoc['photos']): boolean {
  return Boolean(p?.selfieKey && p.vehicleKey);
}

/**
 * Next verification status after an edit. Nothing here ever returns
 * `verified` for new data: only an admin action (ProfileVerificationService)
 * does. An edit to already-verified data sends it back to review, so details
 * cannot be swapped after approval.
 */
export function nextStatus(previous: VerificationStatus, complete: boolean, changed: boolean): VerificationStatus {
  if (!complete) return 'incomplete';
  if (previous === 'verified') return changed ? 'pending_review' : 'verified';
  return 'pending_review'; // incomplete / rejected / pending_review -> (re)submitted for review
}

/**
 * Driver profile: personal details, KYC identity, vehicle, bank/payout
 * details and photos (docs/decisions/029). `driverId` is always the
 * authenticated driver's id.
 */
export class DriverProfileService implements PhotoTarget {
  readonly photos: ProfilePhotoService;

  constructor(
    private readonly store: ProfileStore = new FirestoreProfileStore(DRIVER_PROFILES_COLLECTION),
    private readonly drivers: DriverService = new DriverService(),
    private readonly crypto: FieldCrypto | null = (() => {
      const key = loadProfileEncryptionKey();
      return key ? new FieldCrypto(key) : null;
    })(),
    private readonly storage: ObjectStorage = createObjectStorage(),
    private readonly commissionBps: number | null = loadCommissionBps(),
    private readonly now: () => Date = () => new Date(),
    private readonly events: AppEvents = appEvents
  ) {
    this.photos = new ProfilePhotoService('driver', storage, this);
  }

  private async load(driverId: string): Promise<DriverProfileDoc> {
    const raw = (await this.store.get(driverId)) as DriverProfileDoc | null;
    if (raw) return raw;
    const at = this.now();
    return { driverId, kycStatus: 'incomplete', bankStatus: 'incomplete', createdAt: at, updatedAt: at, ...(this.commissionBps !== null ? { commissionBps: this.commissionBps } : {}) };
  }

  private requireCrypto(): FieldCrypto {
    if (!this.crypto) throw new AppError(503, 'Secure storage is not configured.');
    return this.crypto;
  }

  toDto(doc: DriverProfileDoc): DriverProfileDto {
    const identity = doc.identity ?? {};
    return {
      personal: doc.personal ?? null,
      identity: {
        aadhaarMasked: identity.aadhaarLast4 ? `XXXX-XXXX-${identity.aadhaarLast4}` : null,
        panMasked: identity.panMasked ?? null,
        licenceMasked: identity.licenceMasked ?? null,
        licenceExpiry: identity.licenceExpiry ?? null,
      },
      vehicle: doc.vehicle ?? null,
      bank: doc.bank
        ? {
            accountHolderName: doc.bank.accountHolderName,
            accountMasked: doc.bank.accountLast4 ? `••••${doc.bank.accountLast4}` : null,
            ifsc: doc.bank.ifsc,
            bankName: doc.bank.bankName ?? null,
            upiId: doc.bank.upiId ?? null,
          }
        : null,
      photos: { selfieUrl: this.photos.viewUrl(doc.photos?.selfieKey), vehicleUrl: this.photos.viewUrl(doc.photos?.vehicleKey) },
      kycStatus: doc.kycStatus,
      bankStatus: doc.bankStatus,
      kycReviewNote: reviewNote(doc.kycStatus, doc.kycReview),
      bankReviewNote: reviewNote(doc.bankStatus, doc.bankReview),
      payoutReady: doc.kycStatus === 'verified' && doc.bankStatus === 'verified' && bankDone(doc.bank),
      commissionBps: doc.commissionBps ?? null,
      completeness: buildCompleteness([
        { key: 'personal', label: 'Personal details', done: personalDone(doc.personal) },
        { key: 'identity', label: 'Identity & licence', done: identityDone(doc.identity) },
        { key: 'vehicle', label: 'Vehicle', done: vehicleDone(doc.vehicle) },
        { key: 'bank', label: 'Bank & payouts', done: bankDone(doc.bank) },
        { key: 'photos', label: 'Live photos', done: photosDone(doc.photos) },
      ]),
    };
  }

  async get(driverId: string): Promise<DriverProfileDto> {
    return this.toDto(await this.load(driverId));
  }

  async update(driverId: string, input: DriverProfileInput): Promise<DriverProfileDto> {
    const doc = await this.load(driverId);
    const before = { kyc: doc.kycStatus, bank: doc.bankStatus };
    let kycChanged = false;
    let bankChanged = false;

    if (input.personal) {
      doc.personal = { ...input.personal, address: { ...input.personal.address }, emergencyContact: { ...input.personal.emergencyContact } };
      kycChanged = true;
    }

    if (input.identity) {
      const next = { ...(doc.identity ?? {}) };
      const { aadhaarNumber, panNumber, licenceNumber, licenceExpiry } = input.identity;
      // Aadhaar: validated, then ONLY the last 4 digits are kept — the full number is never stored or logged.
      if (aadhaarNumber) next.aadhaarLast4 = lastChars(normalizeAadhaar(aadhaarNumber), 4);
      if (panNumber) {
        const pan = normalizeUpper(panNumber);
        next.panEnc = this.requireCrypto().encrypt(pan, ctx(driverId, 'pan'));
        next.panMasked = maskLast(pan);
      }
      if (licenceNumber) {
        const licence = normalizeUpper(licenceNumber);
        next.licenceEnc = this.requireCrypto().encrypt(licence, ctx(driverId, 'licence'));
        next.licenceMasked = maskLast(licence);
      }
      if (licenceExpiry) next.licenceExpiry = licenceExpiry;
      doc.identity = next;
      kycChanged = true;
    }

    if (input.vehicle) {
      doc.vehicle = { type: input.vehicle.type, registrationNumber: normalizeUpper(input.vehicle.registrationNumber), ...(input.vehicle.makeModel ? { makeModel: input.vehicle.makeModel } : {}) };
      kycChanged = true;
    }

    if (input.bank) {
      const b = input.bank;
      const next: NonNullable<DriverProfileDoc['bank']> = {
        accountHolderName: b.accountHolderName,
        ifsc: normalizeUpper(b.ifsc),
        ...(b.bankName ? { bankName: b.bankName } : {}),
        ...(b.upiId ? { upiId: b.upiId } : {}),
        ...(doc.bank?.accountEnc ? { accountEnc: doc.bank.accountEnc, accountLast4: doc.bank.accountLast4 } : {}),
      };
      if (b.accountNumber) {
        const account = b.accountNumber.replace(/[\s-]/g, '');
        next.accountEnc = this.requireCrypto().encrypt(account, ctx(driverId, 'bank-account'));
        next.accountLast4 = lastChars(account, 4);
      }
      doc.bank = next;
      bankChanged = true;
    }

    this.recompute(doc, kycChanged, bankChanged);
    doc.updatedAt = this.now();
    await this.store.set(driverId, doc as unknown as Record<string, unknown>);
    this.announceSubmission(driverId, before, doc);

    // Display fields live on the main driver document (merchants see the name; the masked call rings the phone).
    if (input.personal) await this.drivers.updateContact(driverId, { name: input.personal.fullName, phoneNumber: input.personal.contactPhone });
    return this.toDto(doc);
  }

  private recompute(doc: DriverProfileDoc, kycChanged: boolean, bankChanged: boolean) {
    const kycComplete = personalDone(doc.personal) && identityDone(doc.identity) && vehicleDone(doc.vehicle) && photosDone(doc.photos);
    doc.kycStatus = nextStatus(doc.kycStatus, kycComplete, kycChanged);
    doc.bankStatus = nextStatus(doc.bankStatus, bankDone(doc.bank), bankChanged);
  }

  // ---- PhotoTarget ----
  async getPhotoKey(driverId: string, kind: string): Promise<string | null> {
    const doc = await this.load(driverId);
    return (kind === 'selfie' ? doc.photos?.selfieKey : doc.photos?.vehicleKey) ?? null;
  }

  async setPhotoKey(driverId: string, kind: string, key: string | null): Promise<void> {
    const doc = await this.load(driverId);
    const photos = { ...(doc.photos ?? {}) } as NonNullable<DriverProfileDoc['photos']>;
    const field = kind === 'selfie' ? 'selfie' : 'vehicle';
    if (key) {
      photos[`${field}Key`] = key;
      photos[`${field}CapturedAt`] = this.now(); // confirm time = when the live photo reached us
    } else {
      delete photos[`${field}Key`];
      delete photos[`${field}CapturedAt`];
    }
    doc.photos = photos;
    const before = { kyc: doc.kycStatus, bank: doc.bankStatus };
    this.recompute(doc, true, false); // photos are KYC evidence: a change re-opens review
    doc.updatedAt = this.now();
    await this.store.set(driverId, doc as unknown as Record<string, unknown>);
    this.announceSubmission(driverId, before, doc);
  }

  /** Tell the admins when something newly entered review (not on every edit of a profile already waiting). */
  private announceSubmission(driverId: string, before: { kyc: VerificationStatus; bank: VerificationStatus }, doc: DriverProfileDoc): void {
    const newlyPending = (before.kyc !== 'pending_review' && doc.kycStatus === 'pending_review') || (before.bank !== 'pending_review' && doc.bankStatus === 'pending_review');
    if (newlyPending) void this.events.kycSubmitted({ kind: 'driver', driverId }, String(doc.updatedAt.getTime()));
  }

  /** For the future admin tool only (see ProfileVerificationService). */
  async setVerification(driverId: string, patch: { kycStatus?: VerificationStatus; bankStatus?: VerificationStatus }): Promise<void> {
    const doc = await this.load(driverId);
    if (patch.kycStatus) doc.kycStatus = patch.kycStatus;
    if (patch.bankStatus) doc.bankStatus = patch.bankStatus;
    doc.updatedAt = this.now();
    await this.store.set(driverId, doc as unknown as Record<string, unknown>);
  }

  /** Server-side only (payout job, support): decrypts a stored value. Never exposed over HTTP. */
  readSensitive(doc: DriverProfileDoc, driverId: string, field: 'pan' | 'licence' | 'bank-account'): string | null {
    const envelope = field === 'pan' ? doc.identity?.panEnc : field === 'licence' ? doc.identity?.licenceEnc : doc.bank?.accountEnc;
    return envelope ? this.requireCrypto().decrypt(envelope, ctx(driverId, field)) : null;
  }
}
