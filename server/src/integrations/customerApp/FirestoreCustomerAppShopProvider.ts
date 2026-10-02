import { getFirebaseAdminApp } from '../firebase/firebaseAdmin';
import type { CustomerAppShopProvider } from './CustomerAppShopProvider';

export class FirestoreCustomerAppShopProvider implements CustomerAppShopProvider {
  async getShop(customerAppShopId: string): Promise<unknown | null> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection('shops').doc(customerAppShopId).get();
    return snapshot.exists ? (snapshot.data() ?? null) : null;
  }
}
