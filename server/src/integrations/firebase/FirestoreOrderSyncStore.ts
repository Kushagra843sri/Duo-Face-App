import { getFirebaseAdminApp } from './firebaseAdmin';

const COLLECTION = 'duo_face_order_sync';

/** DI seam for CustomerOrderSyncService (docs/decisions/024). */
export interface OrderSyncStore {
  get(orderId: string): Promise<Record<string, unknown> | null>;
  set(orderId: string, data: Record<string, unknown>): Promise<void>;
  /** Single-field `in` query (no composite index). */
  listByStates(states: string[], limit: number): Promise<Record<string, unknown>[]>;
}

export class FirestoreOrderSyncStore implements OrderSyncStore {
  async get(orderId: string): Promise<Record<string, unknown> | null> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(COLLECTION).doc(orderId).get();
    return snapshot.exists ? (snapshot.data() ?? null) : null;
  }

  async set(orderId: string, data: Record<string, unknown>): Promise<void> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    await db.collection(COLLECTION).doc(orderId).set(data);
  }

  async listByStates(states: string[], limit: number): Promise<Record<string, unknown>[]> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(COLLECTION).where('state', 'in', states).limit(limit).get();
    return snapshot.docs.map((doc) => doc.data());
  }
}
