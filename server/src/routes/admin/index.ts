import { Router } from 'express';
import type { RequestHandler } from 'express';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticateFirebase } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorize';
import { createRateLimiter } from '../../middleware/rateLimit';
import { resolveRole } from '../../middleware/resolveRole';
import { RefundService } from '../../services/refundService';
import { DuoFaceRoleResolver } from '../../services/roleResolver';
import type { RoleResolver } from '../../services/roleResolver';
import type { AuthenticatedRequest } from '../../types/auth';

export const ADMIN_RATE_LIMIT = { windowMs: 60_000, max: 60 };

/**
 * Admin-only routes. Role comes from the server (allowlisted Firebase UID),
 * never from the client. Refunds are always the FULL amount paid: there is no
 * amount in any request, so none can be tampered with.
 */
export function createAdminRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  roleResolver: RoleResolver = new DuoFaceRoleResolver(),
  refunds: RefundService = new RefundService(null),
  limiter: RequestHandler = createRateLimiter({
    ...ADMIN_RATE_LIMIT,
    keyFor: (req) => req.identity?.firebaseUid,
  }) as RequestHandler
) {
  const router = Router();
  router.use(authenticateFirebase(verifier), resolveRole(roleResolver), requireRole('admin'), limiter);

  router.get('/me', (req: AuthenticatedRequest, res) => {
    res.json({ firebaseUid: req.principal!.firebaseUid, role: 'admin' });
  });

  router.get(
    '/refunds',
    asyncHandler(async (_req, res) => {
      res.json(await refunds.list());
    })
  );

  router.get(
    '/refunds/:orderId',
    asyncHandler(async (req, res) => {
      res.json({ refund: await refunds.get(req.params.orderId) });
    })
  );

  router.post(
    '/refunds/:orderId',
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json({ refund: await refunds.startRefund(req.principal!.firebaseUid, req.params.orderId) });
    })
  );

  router.post(
    '/refunds/:orderId/refresh',
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json({ refund: await refunds.refresh(req.principal!.firebaseUid, req.params.orderId) });
    })
  );

  return router;
}
