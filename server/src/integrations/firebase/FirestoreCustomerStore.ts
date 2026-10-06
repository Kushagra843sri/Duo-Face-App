import { getFirebaseAdminApp } from './firebaseAdmin';

type Doc = Record<string, unknown>;

/** Transaction handle. Reads run immediately; writes are buffered and applied after all reads. */
export interface CheckoutTx {
  get(collection: string, id: string): Promise<Doc | null>;
  set(collection: string, id: string, data: Doc): void;
}

/**
 * DI seam for everything the customer endpoints touch. Tests inject an
 * in-memory fake; production uses Firestore through the Admin SDK only.
 */
export interface CustomerStore {
  listShops(): Promise<Doc[]>;
  getShop(shopId: string): Promise<Doc | null>;
  listProductsByShop(shopId: string): Promise<Doc[]>;
  listAddresses(uid: string): Promise<Doc[]>;
  getAddress(uid: string, addressId: string): Promise<Doc | null>;
  setAddress(uid: string, addressId: string, data: Doc): Promise<void>;
  deleteAddress(uid: string, addressId: string): Promise<void>;
  listOrdersByCustomer(uid: string): Promise<Doc[]>;
  getOrder(orderId: string): Promise<Doc | null>;
  runTransaction<T>(fn: (tx: CheckoutTx) => Promise<T>): Promise<T>;
}

export class FirestoreCustomerStore implements CustomerStore {
  private async db() {
    // Deferred so merely importing this class never loads firebase-admin under Jest.
    const { getFirestore } = await import('firebase-admin/firestore');
    return getFirestore(getFirebaseAdminApp());
  }

  async listShops(): Promise<Doc[]> {
    const snap = await (await this.db()).collection('shops').get();
    return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  }

  async getShop(shopId: string): Promise<Doc | null> {
    const snap = await (await this.db()).collection('shops').doc(shopId).get();
    return snap.exists ? { ...snap.data(), id: snap.id } : null;
  }

  async listProductsByShop(shopId: string): Promise<Doc[]> {
    const snap = await (await this.db()).collection('products').where('shopId', '==', shopId).get();
    return snap.docs.map((d) => ({ ...d.data(), id: d.id }));
  }

  async listAddresses(uid: string): Promise<Doc[]> {
    const snap = await (await this.db()).collection('users').doc(uid).collection('addresses').get();
    return snap.docs.map((d) => ({ ...d.data(), addressId: d.id }));
  }

  async getAddress(uid: string, addressId: string): Promise<Doc | null> {
    const snap = await (await this.db()).collection('users').doc(uid).collection('addresses').doc(addressId).get();
    return snap.exists ? { ...snap.data(), addressId: snap.id } : null;
  }

  async setAddress(uid: string, addressId: string, data: Doc): Promise<void> {
    await (await this.db()).collection('users').doc(uid).collection('addresses').doc(addressId).set(data, { merge: true });
  }

  async deleteAddress(uid: string, addressId: string): Promise<void> {
    await (await this.db()).collection('users').doc(uid).collection('addresses').doc(addressId).delete();
  }

  async listOrdersByCustomer(uid: string): Promise<Doc[]> {
    // Equality-only query (auto-indexed); sorted in the service.
    const snap = await (await this.db()).collection('orders').where('customerId', '==', uid).get();
    return snap.docs.map((d) => ({ ...d.data(), orderId: d.id }));
  }

  async getOrder(orderId: string): Promise<Doc | null> {
    const snap = await (await this.db()).collection('orders').doc(orderId).get();
    return snap.exists ? { ...snap.data(), orderId: snap.id } : null;
  }

  async runTransaction<T>(fn: (tx: CheckoutTx) => Promise<T>): Promise<T> {
    const db = await this.db();
    return db.runTransaction(async (tx) => {
      // Firestore may re-run this callback on contention: fn must only read through `handle`
      // and be safe to repeat. Writes are applied only after every read has finished.
      const writes: { collection: string; id: string; data: Doc }[] = [];
      const handle: CheckoutTx = {
        get: async (collection, id) => {
          const snap = await tx.get(db.collection(collection).doc(id));
          return snap.exists ? { ...snap.data() } : null;
        },
        set: (collection, id, data) => {
          writes.push({ collection, id, data });
        },
      };
      const result = await fn(handle);
      for (const w of writes) tx.set(db.collection(w.collection).doc(w.id), w.data);
      return result;
    });
  }
}
