import type { DeliveryAssignment } from '../types/deliveryAssignment';
import { CustomerOrderSyncService } from './customerOrderSyncService';
import { NotificationService } from './notificationService';
import type { OrderStatusService } from './orderStatusService';

/**
 * Side effects of committed assignment transitions. Every method is
 * fire-and-forget from the caller's point of view: nothing here may fail,
 * delay or roll back a Duo-Face assignment transition (docs/decisions/024).
 */
export interface DeliveryLifecycleEffects {
  onAssigned(assignment: DeliveryAssignment): Promise<void>;
  onAccepted(assignment: DeliveryAssignment): Promise<void>;
  onPickedUp(assignment: DeliveryAssignment): Promise<void>;
  onDelivered(assignment: DeliveryAssignment): Promise<void>;
}

export class NoopDeliveryLifecycleEffects implements DeliveryLifecycleEffects {
  async onAssigned(): Promise<void> {}
  async onAccepted(): Promise<void> {}
  async onPickedUp(): Promise<void> {}
  async onDelivered(): Promise<void> {}
}

/**
 * Delegating holder so services can default to "the process-wide effects"
 * without importing Firestore-backed collaborators. It is a no-op until
 * server.ts installs the real implementation, which keeps unit tests and the
 * bare `app` free of external side effects.
 */
export class DeliveryLifecycleEffectsHub implements DeliveryLifecycleEffects {
  private delegate: DeliveryLifecycleEffects = new NoopDeliveryLifecycleEffects();

  install(delegate: DeliveryLifecycleEffects): void {
    this.delegate = delegate;
  }
  onAssigned(a: DeliveryAssignment) {
    return this.delegate.onAssigned(a);
  }
  onAccepted(a: DeliveryAssignment) {
    return this.delegate.onAccepted(a);
  }
  onPickedUp(a: DeliveryAssignment) {
    return this.delegate.onPickedUp(a);
  }
  onDelivered(a: DeliveryAssignment) {
    return this.delegate.onDelivered(a);
  }
}

export const deliveryLifecycleEffectsHub = new DeliveryLifecycleEffectsHub();

/**
 * Real effects. Customer App sync and customer notifications are separate,
 * independent side effects: either may fail without affecting the other or
 * the Duo-Face assignment. Failures are logged as ids + category only.
 */
export class DeliveryLifecycleEffectsService implements DeliveryLifecycleEffects {
  constructor(
    private readonly sync: CustomerOrderSyncService,
    private readonly notifications: NotificationService,
    /** When set, a pickup also moves the order to out_for_delivery (decision 031). */
    private readonly orderStatus?: OrderStatusService
  ) {}

  onAssigned(a: DeliveryAssignment) {
    return this.notifications.notify('delivery_assigned', a).then(() => undefined);
  }

  onAccepted(a: DeliveryAssignment) {
    return this.notifications.notify('delivery_accepted', a).then(() => undefined);
  }

  async onPickedUp(a: DeliveryAssignment): Promise<void> {
    if (this.orderStatus) {
      try {
        await this.orderStatus.markOutForDelivery(a.orderId, a.customerAppShopId, { type: 'driver', id: a.driverId });
      } catch {
        console.warn(`DeliveryLifecycleEffects: could not mark order ${a.orderId} out for delivery`);
      }
    }
    await this.notifications.notify('driver_picked_up', a);
  }

  async onDelivered(a: DeliveryAssignment): Promise<void> {
    try {
      await this.sync.syncDelivered(a.orderId, a.customerAppShopId);
    } catch {
      console.warn(`DeliveryLifecycleEffects: order sync errored for order ${a.orderId}`);
    }
    await this.notifications.notify('delivery_completed', a);
  }
}
