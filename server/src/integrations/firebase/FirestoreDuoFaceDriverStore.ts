import { getFirebaseAdminApp } from './firebaseAdmin';

const COLLECTION = 'duo_face_drivers';

/**
 * DI seam: DriverService depends on this interface, not the concrete class,
 * so tests can inject an in-memory fake instead of touching real
 * firebase-admin or requiring a live Firebase project.
 */
export interface DuoFaceDriverStore {
  get(driverId: string): Promise<Record<string, unknown> | null>;
  set(driverId: string, data: Record<string, unknown>): Promise<void>;
  findByFirebaseUid(firebaseUid: string): Promise<Record<string, unknown> | null>;
  listByStatus(status: string): Promise<Record<string, unknown>[]>;
}

export class FirestoreDuoFaceDriverStore implements DuoFaceDriverStore {
  async get(driverId: string): Promise<Record<string, unknown> | null> {
    // Deferred until actually called â€” same reason as the other Firestore
    // stores in this codebase: don't let merely importing this class pull
    // in firebase-admin/firestore under Jest.
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(COLLECTION).doc(driverId).get();
    return snapshot.exists ? (snapshot.data() ?? null) : null;
  }

  async set(driverId: string, data: Record<string, unknown>): Promise<void> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    await db.collection(COLLECTION).doc(driverId).set(data);
  }

  async findByFirebaseUid(firebaseUid: string): Promise<Record<string, unknown> | null> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(COLLECTION).where('firebaseUid', '==', firebaseUid).limit(1).get();
    return snapshot.empty ? null : (snapshot.docs[0].data() ?? null);
  }

  /**
   * Single-field equality query, no `orderBy` — no composite index is
   * assumed to exist (same caution as the other stores).
   */
  async listByStatus(status: string): Promise<Record<string, unknown>[]> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(COLLECTION).where('status', '==', status).get();
    return snapshot.docs.map((doc) => doc.data());
  }
}
