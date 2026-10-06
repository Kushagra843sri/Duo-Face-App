import { FirestoreProfileStore } from '../integrations/firebase/FirestoreProfileStore';
import type { ReviewableProfileStore } from '../integrations/firebase/FirestoreProfileStore';
import { AppError } from '../middleware/errorHandler';
import { DRIVER_PROFILES_COLLECTION, MERCHANT_PROFILES_COLLECTION } from '../types/profile';
import type { ReviewRecord, VerificationStatus } from '../types/profile';
import { appEvents } from './appEvents';
import type { AppEvents, KycSubject } from './appEvents';
import { DriverProfileService } from './driverProfileService';
import type { DriverProfileDto } from './driverProfileService';
import { MerchantProfileService } from './merchantProfileService';
import type { MerchantProfileDto } from './merchantProfileService';

type Doc = Record<string, unknown>;

export type ReviewKind = 'driver' | 'merchant';
export type ReviewSection = 'kyc' | 'bank';

export interface VerificationQueueItem {
  kind: ReviewKind;
  ownerId: string;
  name: string;
  sections: { kyc: VerificationStatus; bank: VerificationStatus };
  /** Which sections are waiting for a decision. */
  pending: ReviewSection[];
  submittedAt: string | null;
}

export interface VerificationDetail {
  kind: ReviewKind;
  ownerId: string;
  name: string;
  /** Opaque token: a decision is only applied if the profile is still exactly this version. */
  version: string;
  sections: { kyc: VerificationStatus; bank: VerificationStatus };
  /** Masked IDs and short-lived photo links, exactly what the owner sees: full Aadhaar/PAN/licence/account numbers never leave the server. */
  profile: DriverProfileDto | MerchantProfileDto;
  /** A driving licence past its expiry date cannot be approved. */
  licenceExpired: boolean;
  history: { section: ReviewSection; decision: 'approved' | 'rejected'; reason: string | null; at: string | null }[];
}

export interface DecisionInput {
  approve: boolean;
  reason?: string;
  version: string;
}

const HISTORY_LIMIT = 50;
const HISTORY_SHOWN = 5;

function millis(value: unknown): number | null {
  if (Object.prototype.toString.call(value) === '[object Date]') return (value as Date).getTime();
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') return (value as { toDate: () => Date }).toDate().getTime();
  if (typeof value === 'string' && value) {
    const t = Date.parse(value);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

const iso = (value: unknown): string | null => {
  const m = millis(value);
  return m === null ? null : new Date(m).toISOString();
};

const status = (value: unknown): VerificationStatus =>
  value === 'pending_review' || value === 'verified' || value === 'rejected' ? value : 'incomplete';

/**
 * Admin review of driver and shop KYC / bank details. The queue is everything
 * in `pending_review`. A decision is applied only if the profile is still
 * EXACTLY the version the admin looked at (atomic compare-and-set), so
 * details cannot be swapped between viewing and approving. Every decision is
 * recorded on the profile (who, when, why) in the same write, the applicant
 * is told, and a rejection always carries a reason they can act on.
 * Approval changes status only: it does not block or unblock anything yet.
 */
export class ProfileVerificationService {
  constructor(
    private readonly driverStore: ReviewableProfileStore = new FirestoreProfileStore(DRIVER_PROFILES_COLLECTION),
    private readonly merchantStore: ReviewableProfileStore = new FirestoreProfileStore(MERCHANT_PROFILES_COLLECTION),
    private readonly driverProfiles: Pick<DriverProfileService, 'get'> = new DriverProfileService(),
    private readonly merchantProfiles: Pick<MerchantProfileService, 'get'> = new MerchantProfileService(),
    private readonly events: AppEvents = appEvents,
    private readonly now: () => Date = () => new Date()
  ) {}

  private store(kind: ReviewKind): ReviewableProfileStore {
    return kind === 'driver' ? this.driverStore : this.merchantStore;
  }

  private ownerIdOf(kind: ReviewKind, doc: Doc): string {
    return String((kind === 'driver' ? doc.driverId : doc.shopId) ?? doc._id ?? '');
  }

  private nameOf(kind: ReviewKind, doc: Doc): string {
    const personal = (doc.personal ?? {}) as Doc;
    return String((kind === 'driver' ? personal.fullName : personal.shopName) ?? '');
  }

  private subject(kind: ReviewKind, ownerId: string): KycSubject {
    return kind === 'driver' ? { kind: 'driver', driverId: ownerId } : { kind: 'merchant', shopId: ownerId };
  }

  /** Oldest submission first, so nobody waits behind newer people. */
  async list(): Promise<VerificationQueueItem[]> {
    const items: VerificationQueueItem[] = [];
    for (const kind of ['driver', 'merchant'] as const) {
      for (const doc of await this.store(kind).listPending()) {
        const sections = { kyc: status(doc.kycStatus), bank: status(doc.bankStatus) };
        const pending = (['kyc', 'bank'] as const).filter((s) => sections[s] === 'pending_review');
        if (pending.length === 0) continue;
        items.push({ kind, ownerId: this.ownerIdOf(kind, doc), name: this.nameOf(kind, doc), sections, pending, submittedAt: iso(doc.updatedAt) });
      }
    }
    return items.sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''));
  }

  async get(kind: ReviewKind, ownerId: string): Promise<VerificationDetail> {
    const doc = await this.store(kind).get(ownerId);
    if (!doc) throw new AppError(404, 'Profile not found.');
    const version = millis(doc.updatedAt);
    if (version === null) throw new AppError(409, 'This profile cannot be reviewed (it has no update time).');

    const profile = kind === 'driver' ? await this.driverProfiles.get(ownerId) : await this.merchantProfiles.get(ownerId);
    const expiry = kind === 'driver' ? ((doc.identity ?? {}) as Doc).licenceExpiry : undefined;
    const history = ((doc.reviewHistory as ReviewRecord[] | undefined) ?? []).slice(-HISTORY_SHOWN).reverse();

    return {
      kind,
      ownerId,
      name: this.nameOf(kind, doc),
      version: String(version),
      sections: { kyc: status(doc.kycStatus), bank: status(doc.bankStatus) },
      profile,
      licenceExpired: typeof expiry === 'string' && expiry < this.now().toISOString().slice(0, 10),
      history: history.map((h) => ({ section: h.section, decision: h.decision, reason: h.reason ?? null, at: iso(h.at) })),
    };
  }

  async decide(adminUid: string, kind: ReviewKind, ownerId: string, section: ReviewSection, input: DecisionInput): Promise<VerificationDetail> {
    const store = this.store(kind);
    const doc = await store.get(ownerId);
    if (!doc) throw new AppError(404, 'Profile not found.');

    const field = section === 'kyc' ? 'kycStatus' : 'bankStatus';
    if (status(doc[field]) !== 'pending_review') throw new AppError(409, 'This section is not waiting for review.');

    const reason = input.reason?.trim() ?? '';
    if (!input.approve && (reason.length < 3 || reason.length > 200)) {
      throw new AppError(400, 'Give a reason (3 to 200 characters) so the person knows what to fix.');
    }

    const expected = Number(input.version);
    const current = millis(doc.updatedAt);
    if (current === null || !Number.isFinite(expected) || current !== expected) {
      throw new AppError(409, 'This profile changed since you opened it. Open it again and review the latest details.');
    }

    if (input.approve && kind === 'driver' && section === 'kyc') {
      const expiry = ((doc.identity ?? {}) as Doc).licenceExpiry;
      if (typeof expiry === 'string' && expiry < this.now().toISOString().slice(0, 10)) {
        throw new AppError(409, 'The driving licence has expired. Reject this and ask for an updated one.');
      }
    }

    const at = this.now();
    const record: ReviewRecord = { section, decision: input.approve ? 'approved' : 'rejected', ...(input.approve ? {} : { reason }), by: adminUid, at };
    const next: Doc = {
      ...doc,
      [field]: input.approve ? 'verified' : 'rejected',
      [`${section}Review`]: record,
      reviewHistory: [...((doc.reviewHistory as ReviewRecord[] | undefined) ?? []), record].slice(-HISTORY_LIMIT),
      updatedAt: at,
    };
    delete next._id;
    if (!(await store.replaceIfUnchanged(ownerId, expected, next))) {
      throw new AppError(409, 'This profile changed since you opened it. Open it again and review the latest details.');
    }

    // Told once per decision (the version makes a repeat of the same decision a different, but never duplicate, key).
    void this.events.kycDecided(this.subject(kind, ownerId), input.approve, `${section}-${at.getTime()}`);
    return this.get(kind, ownerId);
  }
}
