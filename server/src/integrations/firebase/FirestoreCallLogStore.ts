import { CALL_LOGS_COLLECTION } from '../../types/callLog';
import { getFirebaseAdminApp } from './firebaseAdmin';

/** DI seam for CustomerCallService (docs/decisions/028). Duo-Face-owned collection. */
export interface CallLogStore {
  get(callId: string): Promise<Record<string, unknown> | null>;
  set(callId: string, data: Record<string, unknown>): Promise<void>;
  /** Single-field equality (no composite index); callers filter by time. */
  listByAssignmentId(assignmentId: string): Promise<Record<string, unknown>[]>;
}

export class FirestoreCallLogStore implements CallLogStore {
  async get(callId: string): Promise<Record<string, unknown> | null> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(CALL_LOGS_COLLECTION).doc(callId).get();
    return snapshot.exists ? (snapshot.data() ?? null) : null;
  }

  async set(callId: string, data: Record<string, unknown>): Promise<void> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    await db.collection(CALL_LOGS_COLLECTION).doc(callId).set(data);
  }

  async listByAssignmentId(assignmentId: string): Promise<Record<string, unknown>[]> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(CALL_LOGS_COLLECTION).where('assignmentId', '==', assignmentId).get();
    return snapshot.docs.map((doc) => doc.data());
  }
}
