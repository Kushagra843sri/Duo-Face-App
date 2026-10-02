import { getFirebaseAdminApp } from './firebaseAdmin';

const COLLECTION = 'duo_face_driver_locations';

/**
 * DI seam: DriverLocationService depends on this interface so tests can
 * inject an in-memory fake instead of touching real firebase-admin.
 *
 * `set` REPLACES the document (no merge) so stale optional fields
 * (heading/speed) from a previous fix never linger. Document id is the
 * driverId: one latest location per driver, no history.
 */
export interface DriverLocationStore {
  get(driverId: string): Promise<Record<string, unknown> | null>;
  set(driverId: string, data: Record<string, unknown>): Promise<void>;
}

export class FirestoreDriverLocationStore implements DriverLocationStore {
  async get(driverId: string): Promise<Record<string, unknown> | null> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(COLLECTION).doc(driverId).get();
    return snapshot.exists ? (snapshot.data() ?? null) : null;
  }

  /** `updatedAt` is stamped with Firestore's server timestamp, ignoring whatever the caller passed. */
  async set(driverId: string, data: Record<string, unknown>): Promise<void> {
    const { FieldValue, getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    await db
      .collection(COLLECTION)
      .doc(driverId)
      .set({ ...data, updatedAt: FieldValue.serverTimestamp() });
  }
}
