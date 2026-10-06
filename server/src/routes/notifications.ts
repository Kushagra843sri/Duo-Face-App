import { Router } from 'express';
import type { RequestHandler } from 'express';

import { FirebaseAuthService } from '../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../integrations/firebase/FirebaseAuthService';
import { asyncHandler } from '../middleware/asyncHandler';
import { authenticateFirebase } from '../middleware/authenticate';
import { createRateLimiter } from '../middleware/rateLimit';
import { validateBody } from '../middleware/validateBody';
import { NotificationDeviceService } from '../services/notificationDeviceService';
import { Notifier } from '../services/notifier';
import type { AuthenticatedRequest } from '../types/auth';
import { registerDeviceBodySchema } from '../types/notifications';
import type { RegisterDeviceBody } from '../types/notifications';

export const NOTIFICATIONS_RATE_LIMIT = { windowMs: 60_000, max: 60 };

/**
 * Notifications for ANY signed-in person (customer, shop, driver, admin): they
 * authenticate a Firebase token and nothing else, and everything is scoped to
 * the verified uid. A uid is never read from the body, query or path, so
 * nobody can read or touch another person's devices or inbox.
 */
export function createNotificationsRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  notifier: Notifier = new Notifier(),
  devices: NotificationDeviceService = new NotificationDeviceService(),
  limiter: RequestHandler = createRateLimiter({
    ...NOTIFICATIONS_RATE_LIMIT,
    keyFor: (req) => req.identity?.firebaseUid,
  }) as RequestHandler
) {
  const router = Router();
  router.use(authenticateFirebase(verifier), limiter);

  router.post(
    '/device',
    validateBody(registerDeviceBodySchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json(await devices.register(req.identity!.firebaseUid, req.body as RegisterDeviceBody));
    })
  );

  router.delete(
    '/device/:deviceId',
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      await devices.unregister(req.identity!.firebaseUid, req.params.deviceId);
      res.status(204).end();
    })
  );

  router.get(
    '/',
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json(await notifier.list(req.identity!.firebaseUid));
    })
  );

  // Declared before '/:id/read' so "read-all" is never taken for an id.
  router.post(
    '/read-all',
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json(await notifier.markAllRead(req.identity!.firebaseUid));
    })
  );

  router.post(
    '/:id/read',
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      await notifier.markRead(req.identity!.firebaseUid, req.params.id);
      res.status(204).end();
    })
  );

  return router;
}
