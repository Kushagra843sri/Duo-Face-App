import { Router } from 'express';
import type { RequestHandler } from 'express';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticateFirebase } from '../../middleware/authenticate';
import { createRateLimiter } from '../../middleware/rateLimit';
import { validateBody } from '../../middleware/validateBody';
import { NotificationDeviceService } from '../../services/notificationDeviceService';
import type { AuthenticatedRequest } from '../../types/auth';
import { registerDeviceBodySchema } from '../../types/notifications';
import type { RegisterDeviceBody } from '../../types/notifications';

/** 20 registrations / 60 s per Firebase UID. */
export const DEVICE_REGISTRATION_RATE_LIMIT = { windowMs: 60_000, max: 20 };

/**
 * Customer device registration. Like the tracking endpoints it authenticates
 * a Firebase ID token only (no Duo-Face role). The UID is taken from the
 * verified token; the body cannot carry one (strict schema). Push tokens are
 * never logged or returned.
 */
export function createCustomerNotificationsRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  deviceService: NotificationDeviceService = new NotificationDeviceService(),
  limiter: RequestHandler = createRateLimiter({
    ...DEVICE_REGISTRATION_RATE_LIMIT,
    keyFor: (req) => req.identity?.firebaseUid,
  }) as RequestHandler
) {
  const router = Router();

  router.post(
    '/device',
    authenticateFirebase(verifier),
    limiter,
    validateBody(registerDeviceBodySchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json(await deviceService.register(req.identity!.firebaseUid, req.body as RegisterDeviceBody));
    })
  );

  router.delete(
    '/device/:deviceId',
    authenticateFirebase(verifier),
    limiter,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      await deviceService.unregister(req.identity!.firebaseUid, req.params.deviceId);
      res.status(204).end();
    })
  );

  return router;
}
