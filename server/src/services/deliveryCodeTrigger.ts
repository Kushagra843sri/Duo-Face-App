/**
 * Seam between DeliveryAssignmentService (generates + hashes the delivery
 * code inside the pickup transaction) and whatever sends it to the customer.
 * A hub like dispatchTriggerHub: a no-op until server.ts installs the real
 * sender, so tests and the bare app never send anything.
 * The plaintext code only ever travels through this call.
 */
export interface DeliveryCodeTrigger {
  issue(orderId: string, customerAppShopId: string, code: string): Promise<void>;
}

export class DeliveryCodeTriggerHub implements DeliveryCodeTrigger {
  private delegate: DeliveryCodeTrigger = { issue: async () => {} };

  install(delegate: DeliveryCodeTrigger): void {
    this.delegate = delegate;
  }

  issue(orderId: string, customerAppShopId: string, code: string): Promise<void> {
    return this.delegate.issue(orderId, customerAppShopId, code);
  }
}

export const deliveryCodeTriggerHub = new DeliveryCodeTriggerHub();
