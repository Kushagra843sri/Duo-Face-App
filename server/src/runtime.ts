import { FirestoreInboxStore } from './integrations/firebase/FirestoreInboxStore';
import { FirestoreDeliveryCodeStore } from './integrations/firebase/FirestoreDeliveryCodeStore';
import { CustomerOrderSyncService } from './services/customerOrderSyncService';
import { appEvents, AppEventService } from './services/appEvents';
import { DeliveryAssignmentService } from './services/deliveryAssignmentService';
import { DeliveryCodeService } from './services/deliveryCodeService';
import { deliveryCodeTriggerHub } from './services/deliveryCodeTrigger';
import { deliveryLifecycleEffectsHub, DeliveryLifecycleEffectsService } from './services/deliveryLifecycleEffects';
import { DriverDispatchService } from './services/driverDispatchService';
import { DriverNearbyService, nearbyHub } from './services/driverNearby';
import { dispatchTriggerHub } from './services/dispatchTrigger';
import { NotificationService } from './services/notificationService';
import { ShopListingService, shopListingHub } from './services/shopListingService';
import { OrderStatusService } from './services/orderStatusService';

/**
 * Connects the pieces that react to things happening (delivery steps,
 * dispatch, delivery codes, notifications). Everything below is a no-op hub
 * until this runs, which keeps unit tests and the bare `app` free of side
 * effects. server.ts calls it once at start-up; the end-to-end tests call the
 * very same function so they exercise the real wiring.
 */
export function installRuntime(): { orderSync: CustomerOrderSyncService } {
  // Post-commit side effects of delivery steps: order status sync + customer pushes.
  const lookups = new DeliveryAssignmentService(); // its own effects default to the hub; only used for reads here
  const orderSync = new CustomerOrderSyncService(
    undefined,
    undefined,
    undefined,
    undefined,
    async (orderId, shopId) => (await lookups.getCurrentForOrder(orderId, shopId))?.status === 'delivered'
  );
  deliveryLifecycleEffectsHub.install(new DeliveryLifecycleEffectsService(
      orderSync,
      new NotificationService(undefined, undefined, undefined, undefined, undefined, new FirestoreInboxStore()),
      new OrderStatusService()
    ));

  // Notifications to everyone involved (inbox + push).
  appEvents.install(new AppEventService());
  nearbyHub.install(new DriverNearbyService());

  // Keep the customer-facing shop name/address in step with the owner's profile.
  shopListingHub.install(new ShopListingService());

  // Nearest-driver re-offer after a rejection / expired offer (docs/decisions/026).
  dispatchTriggerHub.install(new DriverDispatchService());

  // Keeps the customer's delivery code for the app (and sends the SMS when configured) after a pickup commits (docs/decisions/028).
  deliveryCodeTriggerHub.install(new DeliveryCodeService(undefined, undefined, new FirestoreDeliveryCodeStore()));

  return { orderSync };
}
