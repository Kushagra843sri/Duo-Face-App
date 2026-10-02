import { Router } from 'express';
import type { RequestHandler } from 'express';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticateFirebase } from '../../middleware/authenticate';
import { createRateLimiter } from '../../middleware/rateLimit';
import { CustomerTrackingService } from '../../services/customerTrackingService';
import type { AuthenticatedRequest } from '../../types/auth';

/** 30 lookups / 60 s per Firebase UID: plenty for a screen refresh, cheap protection against order-id probing. */
export const CUSTOMER_TRACKING_RATE_LIMIT = { windowMs: 60_000, max: 30 };

/**
 * Customer endpoints authenticate a Firebase ID token and nothing else —
 * deliberately NOT resolveRole/requireRole (Duo-Face has no customer role;
 * ownership of the Customer App order is the authorization).
 * No customerId or driverId is ever read from the request.
 */
export function createCustomerTrackingRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  trackingService: CustomerTrackingService = new CustomerTrackingService(),
  limiter: RequestHandler = createRateLimiter({
    ...CUSTOMER_TRACKING_RATE_LIMIT,
    keyFor: (req) => req.identity?.firebaseUid,
  }) as RequestHandler
) {
  const router = Router();

  router.get(
    '/orders/:orderId/tracking',
    authenticateFirebase(verifier),
    limiter,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const { tracking } = await trackingService.getSnapshot(req.identity!.firebaseUid, req.params.orderId);
      res.json({ tracking });
    })
  );

  return router;
}
