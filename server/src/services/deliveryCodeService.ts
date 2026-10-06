import { FirestoreCustomerAppOrderProvider } from '../integrations/customerApp/FirestoreCustomerAppOrderProvider';
import type { CustomerAppOrderProvider } from '../integrations/customerApp/CustomerAppOrderProvider';
import { createCustomerCodeSender } from '../integrations/telephony/CustomerCodeSender';
import type { CustomerCodeSender } from '../integrations/telephony/CustomerCodeSender';
import { deliveryCodeContext } from '../integrations/firebase/FirestoreDeliveryCodeStore';
import type { DeliveryCodeStore } from '../integrations/firebase/FirestoreDeliveryCodeStore';
import { loadProfileEncryptionKey } from '../config/profile';
import type { DeliveryCodeTrigger } from './deliveryCodeTrigger';
import { FieldCrypto } from './fieldCrypto';

/**
 * Sends the delivery code to the customer's number on the order (SMS). Fails
 * soft: if it cannot be sent the code path is just unusable for that order
 * and the driver must be within the delivery radius. Never logs the code or
 * the number.
 */
export class DeliveryCodeService implements DeliveryCodeTrigger {
  constructor(
    private readonly orders: CustomerAppOrderProvider = new FirestoreCustomerAppOrderProvider(),
    private readonly sender: CustomerCodeSender = createCustomerCodeSender(),
    /** When set (and a key is configured) the code is also kept, encrypted, for in-app display. */
    private readonly codeStore: DeliveryCodeStore | null = null,
    private readonly crypto: FieldCrypto | null = (() => {
      const key = loadProfileEncryptionKey();
      return key ? new FieldCrypto(key) : null;
    })(),
    private readonly now: () => Date = () => new Date()
  ) {}

  async issue(orderId: string, customerAppShopId: string, code: string): Promise<void> {
    const canStore = this.codeStore !== null && this.crypto !== null;
    if (!this.sender.enabled && !canStore) return;
    const raw = (await this.orders.getOrderById(orderId)) as
      | { orderId?: unknown; shopId?: unknown; delivery?: { phoneNumber?: unknown } }
      | null;
    if (!raw || raw.orderId !== orderId || raw.shopId !== customerAppShopId) return;

    if (canStore) {
      try {
        await this.codeStore!.set(orderId, {
          orderId,
          shopId: customerAppShopId,
          code: this.crypto!.encrypt(code, deliveryCodeContext(orderId)),
          updatedAt: this.now(),
        });
      } catch {
        console.warn(`DeliveryCodeService: could not store the in-app code for order ${orderId}`);
      }
    }
    if (!this.sender.enabled) return;

    const phone = raw.delivery?.phoneNumber;
    if (typeof phone !== 'string' || phone.length === 0) return;

    const result = await this.sender.send(phone, code);
    if (result === 'failed') console.warn(`DeliveryCodeService: code SMS for order ${orderId} failed`);
  }
}
