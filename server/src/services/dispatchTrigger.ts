/**
 * Seam between DeliveryAssignmentService (which owns the lifecycle) and
 * DriverDispatchService (which depends on it): after an offer is rejected or
 * expires, the lifecycle asks for the order to be offered to the next
 * driver. A hub, like deliveryLifecycleEffectsHub, so the dependency points
 * one way and tests / the bare `app` have no dispatch side effects until
 * server.ts installs the real implementation.
 */
export interface DispatchTrigger {
  redispatch(orderId: string, customerAppShopId: string): Promise<void>;
}

export class DispatchTriggerHub implements DispatchTrigger {
  private delegate: DispatchTrigger = { redispatch: async () => {} };

  install(delegate: DispatchTrigger): void {
    this.delegate = delegate;
  }

  redispatch(orderId: string, customerAppShopId: string): Promise<void> {
    return this.delegate.redispatch(orderId, customerAppShopId);
  }
}

export const dispatchTriggerHub = new DispatchTriggerHub();
