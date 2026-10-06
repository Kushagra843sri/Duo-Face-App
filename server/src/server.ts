import 'dotenv/config';

import { createServer } from 'http';

import { app } from './app';
import { loadEnv } from './config/env';
import { FirebaseAuthService } from './integrations/firebase/FirebaseAuthService';
import { attachCustomerTrackingGateway } from './realtime/customerTrackingGateway';
import { CustomerOrderSyncService } from './services/customerOrderSyncService';
import { DeliveryAssignmentService } from './services/deliveryAssignmentService';
import { OrderStatusService } from './services/orderStatusService';
import { deliveryLifecycleEffectsHub, DeliveryLifecycleEffectsService } from './services/deliveryLifecycleEffects';
import { deliveryCodeTriggerHub } from './services/deliveryCodeTrigger';
import { FirestoreDeliveryCodeStore } from './integrations/firebase/FirestoreDeliveryCodeStore';
import { DeliveryCodeService } from './services/deliveryCodeService';
import { DriverDispatchService } from './services/driverDispatchService';
import { dispatchTriggerHub } from './services/dispatchTrigger';
import { NotificationService } from './services/notificationService';
import { paymentService, refundService } from './paymentRuntime';
import { appEvents, AppEventService } from './services/appEvents';
import { DriverNearbyService, nearbyHub } from './services/driverNearby';

const env = loadEnv();

const httpServer = createServer(app);
attachCustomerTrackingGateway(httpServer, { verifier: new FirebaseAuthService() });

// Post-commit side effects (Customer App delivered-sync + customer pushes).
// Installed only here, so tests and the bare `app` have no external side effects.
const lookups = new DeliveryAssignmentService(); // its own effects default to the hub; only used for reads here
const orderSync = new CustomerOrderSyncService(
  undefined,
  undefined,
  undefined,
  undefined,
  async (orderId, shopId) => (await lookups.getCurrentForOrder(orderId, shopId))?.status === 'delivered'
);
deliveryLifecycleEffectsHub.install(new DeliveryLifecycleEffectsService(orderSync, new NotificationService(), new OrderStatusService()));

// Notifications to everyone involved (inbox + push). Installed only here: tests and the bare app send nothing.
appEvents.install(new AppEventService());
nearbyHub.install(new DriverNearbyService());

// Nearest-driver re-offer after a rejection / expired offer (docs/decisions/026).
dispatchTriggerHub.install(new DriverDispatchService());

// Sends the customer their delivery code (SMS) after a pickup commits (docs/decisions/028).
deliveryCodeTriggerHub.install(new DeliveryCodeService(undefined, undefined, new FirestoreDeliveryCodeStore()));

httpServer.listen(env.PORT, () => {
  console.log(`Duo-Face server listening on port ${env.PORT} (${env.NODE_ENV})`);
  // Restart recovery: re-attempt syncs left pending/failed-retryable (bounded, best effort).
  void orderSync.retryOutstanding().catch(() => console.warn('Order sync recovery sweep failed'));

  // Unpaid online orders: confirm late payments and release the stock of the ones that ran out of time (decision 031).
  if (paymentService.enabled) {
    let sweeping = false;
    setInterval(() => {
      if (sweeping) return;
      sweeping = true;
      paymentService
        .sweep()
        .then(() => refundService.sweep())
        .catch(() => console.warn('Payment expiry sweep failed'))
        .finally(() => {
          sweeping = false;
        });
    }, 60_000).unref();
  }
});
