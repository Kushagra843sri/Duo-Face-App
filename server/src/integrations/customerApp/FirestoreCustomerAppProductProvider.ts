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
    return snapshot.docs.map((doc) => doc.data());
  }
}
