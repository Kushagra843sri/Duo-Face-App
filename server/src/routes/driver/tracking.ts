import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticateFirebase } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorize';
import { createRateLimiter } from '../../middleware/rateLimit';
import { requireActiveDriver } from '../../middleware/requireActiveDriver';
import { resolveRole } from '../../middleware/resolveRole';
import { validateBody } from '../../middleware/validateBody';
import { DriverService } from '../../services/driverService';
import { DriverTrackingService } from '../../services/driverTrackingService';
import { DuoFaceRoleResolver } from '../../services/roleResolver';
import type { RoleResolver } from '../../services/roleResolver';
import type { AuthenticatedRequest } from '../../types/auth';
import { driverLocationInputSchema } from '../../types/driverLocation';

const trackingBodySchema = driverLocationInputSchema.extend({ assignmentId: z.string().min(1) }).strict();

/**
 * Publish limit per driver: 12 requests / 60 s. The mobile cadence is one
 * update per >= 10 s (<= 6/min), so this leaves 2x headroom for retries and
 * clock jitter while capping a runaway client at 0.2 writes/s. Per server
 * instance (in-memory) — see middleware/rateLimit.ts.
 */
export const TRACKING_RATE_LIMIT = { windowMs: 60_000, max: 12 };

/**
 * The driver identity always comes from req.driver. assignmentId is the
 * only client-chosen id, and it is verified against that driver's own
 * assignments. There is no :driverId anywhere and no merchant/customer
 * route (docs/decisions/022).
 */
export function createDriverTrackingRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  roleResolver: RoleResolver = new DuoFaceRoleResolver(),
  driverService: DriverService = new DriverService(),
  trackingService: DriverTrackingService = new DriverTrackingService(),
  publishLimiter: RequestHandler = createRateLimiter({
    ...TRACKING_RATE_LIMIT,
    keyFor: (req) => req.driver?.driverId,
  }) as RequestHandler
) {
  const router = Router();

  const guard = [
    authenticateFirebase(verifier),
    resolveRole(roleResolver),
    requireRole('driver'),
    requireActiveDriver(driverService),
  ];

  router.post(
    '/location',
    ...guard,
    publishLimiter,
    validateBody(trackingBodySchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const { assignmentId, ...location } = req.body as z.infer<typeof trackingBodySchema>;
      const result = await trackingService.publishLocation(req.driver!.driverId, assignmentId, location);
      res.json(result);
    })
  );

  router.get(
    '/location/:assignmentId',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json(await trackingService.getLiveLocation(req.driver!.driverId, req.params.assignmentId));
    })
  );

  // Tells the backend this driver stopped publishing. Identity is derived,
  // so there is nothing to pass; idempotent.
  router.delete(
    '/location',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      await trackingService.stopTracking(req.driver!.driverId);
      res.status(204).end();
    })
  );

  return router;
}
