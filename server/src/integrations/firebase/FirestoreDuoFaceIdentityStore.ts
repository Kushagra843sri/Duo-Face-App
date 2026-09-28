import { getFirebaseAdminApp } from './firebaseAdmin';

const COLLECTION = 'duo_face_identities';

/**
 * DI seam: DuoFaceIdentityService depends on this interface, not the
 * concrete class, so tests can inject an in-memory fake instead of touching
 * real firebase-admin or requiring a live Firebase project.
 */
export interface DuoFaceIdentityStore {
  get(firebaseUid: string): Promise<Record<string, unknown> | null>;
  set(firebaseUid: string, data: Record<string, unknown>): Promise<void>;
}

export class FirestoreDuoFaceIdentityStore implements DuoFaceIdentityStore {
  async get(firebaseUid: string): Promise<Record<string, unknown> | null> {
    // Deferred until actually called — same reason as FirebaseAuthService:
    // don't let merely importing this class pull in firebase-admin/firestore
    // (and whatever it transitively requires) under Jest.
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(COLLECTION).doc(firebaseUid).get();
    return snapshot.exists ? (snapshot.data() ?? null) : null;
  }

  async set(firebaseUid: string, data: Record<string, unknown>): Promise<void> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    await db.collection(COLLECTION).doc(firebaseUid).set(data);
  }
}
