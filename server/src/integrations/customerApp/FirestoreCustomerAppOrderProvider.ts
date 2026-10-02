import { getFirebaseAdminApp } from '../firebase/firebaseAdmin';
import { CustomerAppUnavailableError } from './CustomerAppOrderProvider';
import type { CustomerAppOrderProvider, MarkOrderDeliveredOutcome } from './CustomerAppOrderProvider';

const COLLECTION = 'orders';

export class FirestoreCustomerAppOrderProvider implements CustomerAppOrderProvider {
  /**
   * Equality-only query (`where('shopId', '==', shopId)`), no `orderBy` —
   * Firestore auto-indexes single-field equality, but a composite index
   * for shopId+createdAt isn't confirmed to exist (the Customer App's own
   * confirmed composite index is customerId+createdAt, a different one —
   * see docs/decisions/011-merchant-order-boundary.md). Sorting happens in
   * MerchantOrderService instead, after validating each document.
   */
  async listOrdersByShopId(shopId: string): Promise<unknown[]> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(COLLECTION).where('shopId', '==', shopId).get();
    return snapshot.docs.map((doc) => ({ ...doc.data(), orderId: doc.id }));
  }

  async getOrderById(orderId: string): Promise<unknown | null> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(COLLECTION).doc(orderId).get();
    return snapshot.exists ? { ...snapshot.data(), orderId: snapshot.id } : null;
  }

  /**
   * The ONLY Customer App order write in Duo-Face. Runs in a Firestore
   * transaction, so it is a genuine compare-and-set on the order document:
   * the status is read and written inside the same transaction, and Firestore
   * retries/aborts it if the document changes concurrently. Sets exactly one
   * field — `status` — and nothing else (no payment, pricing, items, address,
   * customer/shop ids or timestamps). Target status and the single permitted
   * source status are hard-coded here.
   *
   * Limits of that guarantee: it protects against concurrent writers to this
   * document that go through Firestore. It cannot know about Customer App
   * Cloud Functions/triggers reacting to a status change (none are known to
   * key off `delivered`, but that is unverified) — see decision 024.
   */
  async markOrderDelivered(orderId: string, expectedShopId: string): Promise<MarkOrderDeliveredOutcome> {
    try {
      const { getFirestore } = await import('firebase-admin/firestore');
      const db = getFirestore(getFirebaseAdminApp());
      const ref = db.collection(COLLECTION).doc(orderId);

      return await db.runTransaction(async (tx): Promise<MarkOrderDeliveredOutcome> => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) return { kind: 'not_found' };

        const data = snapshot.data() ?? {};
        if (data.shopId !== expectedShopId) return { kind: 'shop_mismatch' };
        if (data.status === 'delivered') return { kind: 'already_delivered' };
        if (data.status !== 'out_for_delivery') {
          return { kind: 'protected_status', status: typeof data.status === 'string' ? data.status : 'unknown' };
        }

        tx.update(ref, { status: 'delivered' });
        return { kind: 'completed' };
      });
    } catch (err) {
      throw new CustomerAppUnavailableError(classifyFirestoreError(err));
    }
  }
}

// gRPC status codes that will not change on retry.
const PERMANENT_CODES = new Set([3, 5, 7, 9, 12, 16, 'invalid-argument', 'not-found', 'permission-denied', 'failed-precondition', 'unimplemented', 'unauthenticated']);

/** Unknown failures are treated as transient; retries are bounded regardless. */
function classifyFirestoreError(err: unknown): 'transient' | 'permanent' {
  const code = (err as { code?: number | string } | null)?.code;
  return code !== undefined && PERMANENT_CODES.has(code) ? 'permanent' : 'transient';
}
