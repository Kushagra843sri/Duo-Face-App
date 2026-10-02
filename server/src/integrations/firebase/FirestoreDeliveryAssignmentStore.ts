import { getFirebaseAdminApp } from './firebaseAdmin';

const COLLECTION = 'duo_face_delivery_assignments';

/** Thrown by createIfNoActiveAssignmentForOrder on conflict — distinguishable
 * from any other failure so the service can convert it to AppError(409, ...)
 * without string-matching a message. */
export class ActiveAssignmentConflictError extends Error {}

/**
 * DI seam: DeliveryAssignmentService depends on this interface, not the
 * concrete class, so tests can inject an in-memory fake instead of touching
 * real firebase-admin or requiring a live Firebase project.
 *
 * runTransaction's updater is a synchronous, pure function: read the
 * current document (or null), return the next document to write, or throw
 * to abort — same shape as FirestoreInventoryStore.runTransaction. The real
 * implementation runs this *inside* a single Firestore transaction so a
 * concurrent lifecycle mutation can never be lost to an unsafe
 * read-modify-write outside a transaction.
 */
export interface DeliveryAssignmentStore {
  get(assignmentId: string): Promise<Record<string, unknown> | null>;
  listByDriverId(driverId: string): Promise<Record<string, unknown>[]>;
  listByCustomerAppShopId(customerAppShopId: string): Promise<Record<string, unknown>[]>;
  listByOrderId(orderId: string): Promise<Record<string, unknown>[]>;
  createIfNoActiveAssignmentForOrder(
    assignmentId: string,
    orderId: string,
    activeStatuses: string[],
    data: Record<string, unknown>
  ): Promise<void>;
  runTransaction(
    assignmentId: string,
    updater: (current: Record<string, unknown> | null) => Record<string, unknown>,
    sideWrites?: (next: Record<string, unknown>) => AssignmentSideWrite[]
  ): Promise<Record<string, unknown>>;
}

/**
 * A document created in the SAME transaction as an assignment update, only
 * if it does not already exist (never overwrites). Used to make the
 * Customer App sync intent durable atomically with `delivered`.
 */
export interface AssignmentSideWrite {
  collection: string;
  id: string;
  data: Record<string, unknown>;
}

export class FirestoreDeliveryAssignmentStore implements DeliveryAssignmentStore {
  async get(assignmentId: string): Promise<Record<string, unknown> | null> {
    // Deferred until actually called — same reason as the other Firestore
    // stores in this codebase: don't let merely importing this class pull
    // in firebase-admin/firestore under Jest.
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(COLLECTION).doc(assignmentId).get();
    return snapshot.exists ? (snapshot.data() ?? null) : null;
  }

  /**
   * Single-field equality query, no `orderBy` — same caution as
   * FirestoreCustomerAppOrderProvider.listOrdersByShopId: no composite
   * index is assumed to exist. Sorting happens in the service layer.
   */
  async listByDriverId(driverId: string): Promise<Record<string, unknown>[]> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(COLLECTION).where('driverId', '==', driverId).get();
    return snapshot.docs.map((doc) => doc.data());
  }

  /** Single-field equality (auto-indexed). */
  async listByOrderId(orderId: string): Promise<Record<string, unknown>[]> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(COLLECTION).where('orderId', '==', orderId).get();
    return snapshot.docs.map((doc) => doc.data());
  }

  async listByCustomerAppShopId(customerAppShopId: string): Promise<Record<string, unknown>[]> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const snapshot = await db.collection(COLLECTION).where('customerAppShopId', '==', customerAppShopId).get();
    return snapshot.docs.map((doc) => doc.data());
  }

  /**
   * Atomic check-then-write: reads only by `orderId` (single-field
   * equality — auto-indexed, no composite index needed) inside the
   * transaction, filters `activeStatuses` in the callback, and throws
   * before writing if any match. This is what makes "no conflicting active
   * assignment for this order" an actual guarantee rather than a
   * read-then-write race.
   */
  async createIfNoActiveAssignmentForOrder(
    assignmentId: string,
    orderId: string,
    activeStatuses: string[],
    data: Record<string, unknown>
  ): Promise<void> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());

    await db.runTransaction(async (tx) => {
      const snapshot = await tx.get(db.collection(COLLECTION).where('orderId', '==', orderId));
      const hasActive = snapshot.docs.some((doc) => activeStatuses.includes(doc.data().status as string));
      if (hasActive) {
        throw new ActiveAssignmentConflictError(`Order ${orderId} already has an active delivery assignment`);
      }
      tx.set(db.collection(COLLECTION).doc(assignmentId), data);
    });
  }

  async runTransaction(
    assignmentId: string,
    updater: (current: Record<string, unknown> | null) => Record<string, unknown>,
    sideWrites?: (next: Record<string, unknown>) => AssignmentSideWrite[]
  ): Promise<Record<string, unknown>> {
    const { getFirestore } = await import('firebase-admin/firestore');
    const db = getFirestore(getFirebaseAdminApp());
    const ref = db.collection(COLLECTION).doc(assignmentId);

    return db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const current = snapshot.exists ? (snapshot.data() ?? null) : null;
      const next = updater(current); // throws to abort the transaction

      // Firestore requires all reads before any write.
      const sides = (sideWrites?.(next) ?? []).map((side) => ({ side, ref: db.collection(side.collection).doc(side.id) }));
      const existing = await Promise.all(sides.map(({ ref: sideRef }) => tx.get(sideRef)));

      tx.set(ref, next);
      sides.forEach(({ side, ref: sideRef }, index) => {
        if (!existing[index].exists) tx.set(sideRef, side.data);
      });
      return next;
    });
  }
}
