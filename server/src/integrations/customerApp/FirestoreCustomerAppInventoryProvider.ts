import { getFirebaseAdminApp } from '../firebase/firebaseAdmin';
import type { CustomerAppInventoryProvider } from './CustomerAppInventoryProvider';

/**
 * The first real implementation of CustomerAppInventoryProvider (interface
 * defined since Phase 1, deliberately left unimplemented until there was a
 * genuine, minimal need — Phase 6's "does this product exist" check).
 *
 * getProduct() is a read-only existence check against the Customer App's
 * own `products` collection — no field shape is assumed, matching the
 * interface's own `unknown` return type. getStock/adjustStock are NOT
 * implemented: the Customer App has no stock quantity concept at all (see
 * docs/decisions/003-inventory-and-financial-boundaries.md) — implementing
 * them for real here would mean inventing behavior, not reusing evidence.
 */
export class FirestoreCustomerAppInventoryProvider implements CustomerAppInventoryProvider {
  async getProduct(itemId: string): Promise<unknown | null> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection('products').doc(itemId).get();
    return snapshot.exists ? (snapshot.data() ?? null) : null;
  }

  async getStock(_itemId: string): Promise<number | null> {
    throw new Error(
      'The Customer App has no stock quantity concept — see docs/decisions/003-inventory-and-financial-boundaries.md'
    );
  }

  async adjustStock(_itemId: string, _delta: number): Promise<number> {
    throw new Error(
      'The Customer App has no stock quantity concept — see docs/decisions/003-inventory-and-financial-boundaries.md'
    );
  }
}
