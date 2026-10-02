import { FirestoreCustomerAppOrderProvider } from '../integrations/customerApp/FirestoreCustomerAppOrderProvider';
import type { CustomerAppOrderProvider } from '../integrations/customerApp/CustomerAppOrderProvider';
import { createCustomerCodeSender } from '../integrations/telephony/CustomerCodeSender';
import type { CustomerCodeSender } from '../integrations/telephony/CustomerCodeSender';
import type { DeliveryCodeTrigger } from './deliveryCodeTrigger';

/**
 * Sends the delivery code to the customer's number on the order (SMS). Fails
 * soft: if it cannot be sent the code path is just unusable for that order
 * and the driver must be within the delivery radius. Never logs the code or
 * the number.
 */
export class DeliveryCodeService implements DeliveryCodeTrigger {
  constructor(
    private readonly orders: CustomerAppOrderProvider = new FirestoreCustomerAppOrderProvider(),
    private readonly sender: CustomerCodeSender = createCustomerCodeSender()
  ) {}

  async issue(orderId: string, customerAppShopId: string, code: string): Promise<void> {
    if (!this.sender.enabled) return;
    const raw = (await this.orders.getOrderById(orderId)) as
      | { orderId?: unknown; shopId?: unknown; delivery?: { phoneNumber?: unknown } }
      | null;
    if (!raw || raw.orderId !== orderId || raw.shopId !== customerAppShopId) return;
    const phone = raw.delivery?.phoneNumber;
    if (typeof phone !== 'string' || phone.length === 0) return;

    const result = await this.sender.send(phone, code);
    if (result === 'failed') console.warn(`DeliveryCodeService: code SMS for order ${orderId} failed`);
  }
}
