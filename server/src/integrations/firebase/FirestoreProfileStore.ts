import { getFirebaseAdminApp } from './firebaseAdmin';

/**
 * DI seam for the profile services. One document per driver / shop, in a
 * Duo-Face-owned collection (decision 029). The collection is a constructor
 * argument so the same class serves both roles.
 */
export interface ProfileStore {
  get(id: string): Promise<Record<string, unknown> | null>;
  set(id: string, data: Record<string, unknown>): Promise<void>;
}

/** What the admin review needs on top of get/set. */
export interface ReviewableProfileStore extends ProfileStore {
  /** Profiles whose KYC or bank details are waiting for review. */
  listPending(): Promise<Record<string, unknown>[]>;
  /**
   * Writes `data` only if the stored document's `updatedAt` is still
   * `expectedUpdatedAtMs`, atomically. False means it changed (or vanished)
   * since the reviewer looked at it, so the decision must not be applied.
   */
  replaceIfUnchanged(id: string, expectedUpdatedAtMs: number, data: Record<string, unknown>): Promise<boolean>;
}

function millisOf(value: unknown): number | null {
  if (Object.prototype.toString.call(value) === '[object Date]') return (value as Date).getTime();
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') return (value as { toDate: () => Date }).toDate().getTime();
  return null;
}

export class FirestoreProfileStore implements ReviewableProfileStore {
  constructor(private readonly collection: string) {}

  async get(id: string): Promise<Record<string, unknown> | null> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(this.collection).doc(id).get();
    return snapshot.exists ? (snapshot.data() ?? null) : null;
  }

  async set(id: string, data: Record<string, unknown>): Promise<void> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    await db.collection(this.collection).doc(id).set(data);
  }

  async listPending(): Promise<Record<string, unknown>[]> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const col = getFirestore(getFirebaseAdminApp()).collection(this.collection);
    const [kyc, bank] = await Promise.all([
      col.where('kycStatus', '==', 'pending_review').get(),
      col.where('bankStatus', '==', 'pending_review').get(),
    ]);
    const byId = new Map<string, Record<string, unknown>>();
    for (const d of [...kyc.docs, ...bank.docs]) byId.set(d.id, { ...d.data(), _id: d.id });
    return [...byId.values()];
  }

  async replaceIfUnchanged(id: string, expectedUpdatedAtMs: number, data: Record<string, unknown>): Promise<boolean> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const ref = db.collection(this.collection).doc(id);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists || millisOf(snap.data()?.updatedAt) !== expectedUpdatedAtMs) return false;
      tx.set(ref, data);
      return true;
    });
  }
}
