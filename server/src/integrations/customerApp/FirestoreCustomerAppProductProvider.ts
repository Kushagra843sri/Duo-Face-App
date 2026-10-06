import { getFirebaseAdminApp } from '../firebase/firebaseAdmin';
import type { CustomerAppProductProvider } from './CustomerAppProductProvider';

/**
 * Read-only. Queries the Customer App's own `products` collection by its
 * real `shopId` field — never writes, never duplicates the full product
 * document into Duo-Face storage.
 */
export class FirestoreCustomerAppProductProvider implements CustomerAppProductProvider {
  async listProductsByShopId(shopId: string): Promise<unknown[]> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection('products').where('shopId', '==', shopId).get();
    // The document id is the product's identity: never depend on a copy of it stored inside the document.
    return snapshot.docs.map((doc) => ({ ...doc.data(), id: doc.id }));
  }
}
