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

export class FirestoreProfileStore implements ProfileStore {
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
}
