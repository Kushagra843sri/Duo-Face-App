import { getFirebaseAdminApp } from './firebaseAdmin';

const COLLECTION = 'duo_face_shops';

/**
 * DI seam: DuoFaceShopService depends on this interface, not the concrete
 * class, so tests can inject an in-memory fake instead of touching real
 * firebase-admin or requiring a live Firebase project.
 */
export interface DuoFaceShopStore {
  get(shopId: string): Promise<Record<string, unknown> | null>;
  set(shopId: string, data: Record<string, unknown>): Promise<void>;
  findByMerchantFirebaseUid(merchantFirebaseUid: string): Promise<Record<string, unknown> | null>;
  findByCustomerAppShopId(customerAppShopId: string): Promise<Record<string, unknown> | null>;
}

export class FirestoreDuoFaceShopStore implements DuoFaceShopStore {
  async get(shopId: string): Promise<Record<string, unknown> | null> {
    // Deferred until actually called — same reason as the other Firestore
    // stores in this codebase: don't let merely importing this class pull
    // in firebase-admin/firestore under Jest.
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(COLLECTION).doc(shopId).get();
    return snapshot.exists ? (snapshot.data() ?? null) : null;
  }

  async set(shopId: string, data: Record<string, unknown>): Promise<void> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    await db.collection(COLLECTION).doc(shopId).set(data);
  }

  async findByMerchantFirebaseUid(merchantFirebaseUid: string): Promise<Record<string, unknown> | null> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db
      .collection(COLLECTION)
      .where('merchantFirebaseUid', '==', merchantFirebaseUid)
      .limit(1)
      .get();
    return snapshot.empty ? null : (snapshot.docs[0].data() ?? null);
  }

  /** Single-field equality (auto-indexed). */
  async findByCustomerAppShopId(customerAppShopId: string): Promise<Record<string, unknown> | null> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(COLLECTION).where('customerAppShopId', '==', customerAppShopId).limit(1).get();
    return snapshot.empty ? null : (snapshot.docs[0].data() ?? null);
  }
}
