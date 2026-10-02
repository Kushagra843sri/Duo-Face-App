import { getFirebaseAdminApp } from './firebaseAdmin';

const COLLECTION = 'duo_face_delivery_destinations';

/**
 * DI seam for the geocoded-destination cache, keyed by the address hash
 * (document id == addressHash). Duo-Face-owned; never touches Customer App
 * collections.
 *
 * `createIfAbsent` must be atomic (Firestore `create()` fails if the doc
 * exists) so two racers can't produce two documents or overwrite a good
 * one. `replace` is only for the service's controlled repair of a
 * malformed cached document.
 */
export interface DeliveryDestinationStore {
  get(destinationId: string): Promise<Record<string, unknown> | null>;
  /** @returns false when a document already existed (nothing written). */
  createIfAbsent(destinationId: string, data: Record<string, unknown>): Promise<boolean>;
  replace(destinationId: string, data: Record<string, unknown>): Promise<void>;
}

export class FirestoreDeliveryDestinationStore implements DeliveryDestinationStore {
  async get(destinationId: string): Promise<Record<string, unknown> | null> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(COLLECTION).doc(destinationId).get();
    return snapshot.exists ? (snapshot.data() ?? null) : null;
  }

  async createIfAbsent(destinationId: string, data: Record<string, unknown>): Promise<boolean> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    try {
      await db.collection(COLLECTION).doc(destinationId).create(data);
      return true;
    } catch (err) {
      // gRPC ALREADY_EXISTS (6)
      if ((err as { code?: number | string } | null)?.code === 6 || (err as { code?: string } | null)?.code === 'already-exists') {
        return false;
      }
      throw err;
    }
  }

  async replace(destinationId: string, data: Record<string, unknown>): Promise<void> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    await db.collection(COLLECTION).doc(destinationId).set(data);
  }
}
