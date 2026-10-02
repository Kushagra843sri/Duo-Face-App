import { getFirebaseAdminApp } from './firebaseAdmin';

const COLLECTION = 'duo_face_inventory';

/**
 * DI seam: InventoryService depends on this interface, not the concrete
 * class, so tests can inject an in-memory fake instead of touching real
 * firebase-admin or requiring a live Firebase project.
 *
 * runTransaction's updater is a synchronous, pure function: read the
 * current document (or null), return the next document to write, or throw
 * to abort. The real implementation runs this *inside* a single Firestore
 * transaction (get + set on the same tx) so a concurrent adjustment can
 * never be lost to an unsafe read-modify-write outside a transaction.
 */
export interface InventoryStore {
  get(inventoryId: string): Promise<Record<string, unknown> | null>;
  set(inventoryId: string, data: Record<string, unknown>): Promise<void>;
  listByShopId(shopId: string): Promise<Record<string, unknown>[]>;
  runTransaction(
    inventoryId: string,
    updater: (current: Record<string, unknown> | null) => Record<string, unknown>
  ): Promise<Record<string, unknown>>;
}

export class FirestoreInventoryStore implements InventoryStore {
  async get(inventoryId: string): Promise<Record<string, unknown> | null> {
    // Deferred until actually called — same reason as every other
    // Firestore store in this codebase: don't let merely importing this
    // class pull in firebase-admin/firestore under Jest.
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(COLLECTION).doc(inventoryId).get();
    return snapshot.exists ? (snapshot.data() ?? null) : null;
  }

  async set(inventoryId: string, data: Record<string, unknown>): Promise<void> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    await db.collection(COLLECTION).doc(inventoryId).set(data);
  }

  async listByShopId(shopId: string): Promise<Record<string, unknown>[]> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(COLLECTION).where('shopId', '==', shopId).get();
    return snapshot.docs.map((doc) => doc.data());
  }

  async runTransaction(
    inventoryId: string,
    updater: (current: Record<string, unknown> | null) => Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const ref = db.collection(COLLECTION).doc(inventoryId);

    return db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const current = snapshot.exists ? (snapshot.data() ?? null) : null;
      const next = updater(current); // throws to abort the transaction
      tx.set(ref, next);
      return next;
    });
  }
}
