import { loadProfileEncryptionKey } from '../config/profile';
import { deliveryCodeContext, FirestoreDeliveryCodeStore } from '../integrations/firebase/FirestoreDeliveryCodeStore';
import type { DeliveryCodeStore } from '../integrations/firebase/FirestoreDeliveryCodeStore';
import { FirestoreCustomerStore } from '../integrations/firebase/FirestoreCustomerStore';
import type { CustomerStore } from '../integrations/firebase/FirestoreCustomerStore';
import { AppError } from '../middleware/errorHandler';
import { FieldCrypto } from './fieldCrypto';

/**
 * Lets a customer read the 6-digit code they give the delivery partner.
 * Only the order's owner, and only while the order is out for delivery:
 * before pickup no code exists, after delivery it is useless. Never logged.
 */
export class CustomerDeliveryCodeService {
  constructor(
    private readonly orders: CustomerStore = new FirestoreCustomerStore(),
    private readonly codes: DeliveryCodeStore = new FirestoreDeliveryCodeStore(),
    private readonly crypto: FieldCrypto | null = (() => {
      const key = loadProfileEncryptionKey();
      return key ? new FieldCrypto(key) : null;
    })()
  ) {}

  async getCode(uid: string, orderId: string): Promise<{ code: string }> {
    const order = await this.orders.getOrder(orderId);
    // Missing and someone else's look identical.
    if (!order || order.customerId !== uid) throw new AppError(404, 'Order not found');
    if (order.status !== 'out_for_delivery') throw new AppError(409, 'The delivery code is available once your order is on its way.');
    if (!this.crypto) throw new AppError(503, 'Secure storage is not configured.');

    const doc = await this.codes.get(orderId);
    if (!doc || doc.shopId !== order.shopId || typeof doc.code !== 'string') {
      throw new AppError(404, 'No delivery code is available for this order.');
    }
    try {
      return { code: this.crypto.decrypt(doc.code, deliveryCodeContext(orderId)) };
    } catch {
      throw new AppError(404, 'No delivery code is available for this order.');
    }
  }
}
