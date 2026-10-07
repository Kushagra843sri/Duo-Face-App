import { FirestoreCustomerAppOrderProvider } from '../integrations/customerApp/FirestoreCustomerAppOrderProvider';
import type { CustomerAppOrderProvider } from '../integrations/customerApp/CustomerAppOrderProvider';
import { deliveryCodeContext } from '../integrations/firebase/FirestoreDeliveryCodeStore';
import type { DeliveryCodeStore } from '../integrations/firebase/FirestoreDeliveryCodeStore';
import { loadProfileEncryptionKey } from '../config/profile';
import type { DeliveryCodeTrigger } from './deliveryCodeTrigger';
import { FieldCrypto } from './fieldCrypto';

/**
 * Keeps the delivery code, encrypted, so the customer can see it in their app
 * once the order is out for delivery. There is no SMS: the customer reads the
 * code from the app and tells it to the driver. Fails soft: if the code cannot
 * be stored the driver falls back to being within the delivery radius. Never
 * logs the code.
 */
export class DeliveryCodeService implements DeliveryCodeTrigger {
  constructor(
    private readonly orders: CustomerAppOrderProvider = new FirestoreCustomerAppOrderProvider(),
    private readonly codeStore: DeliveryCodeStore | null = null,
    private readonly crypto: FieldCrypto | null = (() => {
      const key = loadProfileEncryptionKey();
      return key ? new FieldCrypto(key) : null;
    })(),
    private readonly now: () => Date = () => new Date()
  ) {}

  async issue(orderId: string, customerAppShopId: string, code: string): Promise<void> {
    if (this.codeStore === null || this.crypto === null) return;
    const raw = (await this.orders.getOrderById(orderId)) as { orderId?: unknown; shopId?: unknown } | null;
    if (!raw || raw.orderId !== orderId || raw.shopId !== customerAppShopId) return;

    try {
      await this.codeStore.set(orderId, {
        orderId,
        shopId: customerAppShopId,
        code: this.crypto.encrypt(code, deliveryCodeContext(orderId)),
        updatedAt: this.now(),
      });
    } catch {
      console.warn(`DeliveryCodeService: could not store the in-app code for order ${orderId}`);
    }
  }
}
