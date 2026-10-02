import { NOTIFICATION_DEVICES_COLLECTION, NOTIFICATION_EVENTS_COLLECTION } from '../../types/notifications';
import { getFirebaseAdminApp } from './firebaseAdmin';

/** Device registrations (docs/decisions/024). Document id = `${firebaseUid}:${deviceId}`. */
export interface NotificationDeviceStore {
  get(docId: string): Promise<Record<string, unknown> | null>;
  set(docId: string, data: Record<string, unknown>): Promise<void>;
  listByFirebaseUid(firebaseUid: string): Promise<Array<Record<string, unknown>>>;
  listByPushToken(pushToken: string): Promise<Array<Record<string, unknown>>>;
}

/**
 * Notification idempotency records. `transact` reads the event document and
 * lets the caller decide (atomically) whether to write and what to return.
 */
export interface NotificationEventStore {
  transact<T>(
    eventId: string,
    decide: (current: Record<string, unknown> | null) => { write?: Record<string, unknown>; result: T }
  ): Promise<T>;
  set(eventId: string, data: Record<string, unknown>): Promise<void>;
}

export class FirestoreNotificationDeviceStore implements NotificationDeviceStore {
  async get(docId: string) {
    const { getFirestore } = await import('firebase-admin/firestore');
    const snapshot = await getFirestore(getFirebaseAdminApp()).collection(NOTIFICATION_DEVICES_COLLECTION).doc(docId).get();
    return snapshot.exists ? (snapshot.data() ?? null) : null;
  }

  async set(docId: string, data: Record<string, unknown>) {
    const { getFirestore } = await import('firebase-admin/firestore');
    await getFirestore(getFirebaseAdminApp()).collection(NOTIFICATION_DEVICES_COLLECTION).doc(docId).set(data);
  }

  async listByFirebaseUid(firebaseUid: string) {
    const { getFirestore } = await import('firebase-admin/firestore');
    const snapshot = await getFirestore(getFirebaseAdminApp())
      .collection(NOTIFICATION_DEVICES_COLLECTION)
      .where('firebaseUid', '==', firebaseUid)
      .get();
    return snapshot.docs.map((doc) => doc.data());
  }

  async listByPushToken(pushToken: string) {
    const { getFirestore } = await import('firebase-admin/firestore');
    const snapshot = await getFirestore(getFirebaseAdminApp())
      .collection(NOTIFICATION_DEVICES_COLLECTION)
      .where('pushToken', '==', pushToken)
      .get();
    return snapshot.docs.map((doc) => doc.data());
  }
}

export class FirestoreNotificationEventStore implements NotificationEventStore {
  async transact<T>(
    eventId: string,
    decide: (current: Record<string, unknown> | null) => { write?: Record<string, unknown>; result: T }
  ): Promise<T> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const ref = db.collection(NOTIFICATION_EVENTS_COLLECTION).doc(eventId);
    return db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const { write, result } = decide(snapshot.exists ? (snapshot.data() ?? null) : null);
      if (write) tx.set(ref, write);
      return result;
    });
  }

  async set(eventId: string, data: Record<string, unknown>) {
    const { getFirestore } = await import('firebase-admin/firestore');
    await getFirestore(getFirebaseAdminApp()).collection(NOTIFICATION_EVENTS_COLLECTION).doc(eventId).set(data);
  }
}
