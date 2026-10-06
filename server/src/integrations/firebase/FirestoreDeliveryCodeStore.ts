import { getFirebaseAdminApp } from './firebaseAdmin';

export const DELIVERY_CODES_COLLECTION = 'duo_face_delivery_codes';

/**
 * The customer's delivery code, stored ENCRYPTED (AES-256-GCM, see
 * FieldCrypto) per order so the customer can see it in the app without SMS
 * (decision 031, amends 028). Verification still uses the HMAC on the
 * assignment, not this document.
 */
export interface DeliveryCodeStore {
  get(orderId: string): Promise<Record<string, unknown> | null>;
  set(orderId: string, data: Record<string, unknown>): Promise<void>;
}

export class FirestoreDeliveryCodeStore implements DeliveryCodeStore {
  async get(orderId: string) {
    const { getFirestore } = await import('firebase-admin/firestore');
    const snap = await getFirestore(getFirebaseAdminApp()).collection(DELIVERY_CODES_COLLECTION).doc(orderId).get();
    return snap.exists ? (snap.data() ?? null) : null;
  }

  async set(orderId: string, data: Record<string, unknown>) {
    const { getFirestore } = await import('firebase-admin/firestore');
    await getFirestore(getFirebaseAdminApp()).collection(DELIVERY_CODES_COLLECTION).doc(orderId).set(data);
  }
}

/** Context bound into the ciphertext so it cannot be replayed onto another order. */
export const deliveryCodeContext = (orderId: string) => `delivery-code:${orderId}`;
