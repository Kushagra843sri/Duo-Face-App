import { Router } from 'express';
import type { RequestHandler } from 'express';
import { z } from 'zod';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticateFirebase } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorize';
import { AppError } from '../../middleware/errorHandler';
import { createRateLimiter } from '../../middleware/rateLimit';
import { resolveRole } from '../../middleware/resolveRole';
import { validateBody } from '../../middleware/validateBody';
import { ProfileVerificationService } from '../../services/profileVerificationService';
import type { ReviewKind, ReviewSection } from '../../services/profileVerificationService';
import { RefundService } from '../../services/refundService';
import { DuoFaceRoleResolver } from '../../services/roleResolver';
import type { RoleResolver } from '../../services/roleResolver';
import type { AuthenticatedRequest } from '../../types/auth';

export const ADMIN_RATE_LIMIT = { windowMs: 60_000, max: 60 };

/** Reason is checked by the service (required on reject); the shape here is strict so nothing else can be smuggled in. */
const decisionBodySchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    reason: z.string().max(200).optional(),
    version: z.string().regex(/^\d{10,16}$/, 'version must come from the profile you opened'),
  })
  .strict();

function parseKind(value: string): ReviewKind {
  if (value === 'driver' || value === 'merchant') return value;
  throw new AppError(404, 'Not found.');
}

function parseSection(value: string): ReviewSection {
  if (value === 'kyc' || value === 'bank') return value;
  throw new AppError(404, 'Not found.');
}

/**
 * Admin-only routes. Role comes from the server (allowlisted Firebase UID),
 * never from the client. Refunds are always the FULL amount paid: there is no
 * amount in any request, so none can be tampered with.
 */
export function createAdminRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  roleResolver: RoleResolver = new DuoFaceRoleResolver(),
  refunds: RefundService = new RefundService(null),
  verifications: ProfileVerificationService = new ProfileVerificationService(),
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

  router.get(
    '/verifications',
    asyncHandler(async (_req, res) => {
      res.json({ items: await verifications.list() });
    })
  );

  router.get(
    '/verifications/:kind/:ownerId',
    asyncHandler(async (req, res) => {
      res.json({ verification: await verifications.get(parseKind(req.params.kind), req.params.ownerId) });
    })
  );

  router.post(
    '/verifications/:kind/:ownerId/:section',
    validateBody(decisionBodySchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const body = req.body as z.infer<typeof decisionBodySchema>;
      const verification = await verifications.decide(
        req.principal!.firebaseUid,
        parseKind(req.params.kind),
        req.params.ownerId,
        parseSection(req.params.section),
        { approve: body.decision === 'approve', reason: body.reason, version: body.version }
      );
      res.json({ verification });
    })
  );

  return router;
}
