import { getFirebaseAdminApp } from './firebaseAdmin';

type Doc = Record<string, unknown>;

/**
 * The customer-visible shop record (`shops/{id}`): what customers browse.
 * Written only by the server (customers have no write access to it).
 */
export interface ShopListingStore {
  get(id: string): Promise<Doc | null>;
  /** Merges `data` into the existing record (it never replaces fields it does not mention). */
  merge(id: string, data: Doc): Promise<void>;
}

export class FirestoreShopListingStore implements ShopListingStore {
  async get(id: string): Promise<Doc | null> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const snap = await getFirestore(getFirebaseAdminApp()).collection('shops').doc(id).get();
    return snap.exists ? { ...snap.data(), id: snap.id } : null;
  }

  async merge(id: string, data: Doc): Promise<void> {
    const { getFirestore } = await import('firebase-admin/firestore');
    await getFirestore(getFirebaseAdminApp()).collection('shops').doc(id).set(data, { merge: true });
  }
}
