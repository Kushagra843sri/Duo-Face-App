import 'dotenv/config';

import { createServer } from 'http';

import { app } from './app';
import { loadEnv } from './config/env';
import { FirebaseAuthService } from './integrations/firebase/FirebaseAuthService';
import { attachCustomerTrackingGateway } from './realtime/customerTrackingGateway';
import { paymentService, refundService } from './paymentRuntime';
import { installRuntime } from './runtime';

const env = loadEnv();

const httpServer = createServer(app);
attachCustomerTrackingGateway(httpServer, { verifier: new FirebaseAuthService() });

// Connect the reactions to delivery steps, dispatch, codes and notifications (see runtime.ts).
const { orderSync } = installRuntime();

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
