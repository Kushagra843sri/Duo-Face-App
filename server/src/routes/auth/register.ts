import { Router } from 'express';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticateFirebase } from '../../middleware/authenticate';
import { createRateLimiter } from '../../middleware/rateLimit';
import { validateBody } from '../../middleware/validateBody';
import { RegistrationService, registerBodySchema } from '../../services/registrationService';
import type { RegisterBody } from '../../services/registrationService';
import type { AuthenticatedRequest } from '../../types/auth';

/**
 * POST /auth/register — authentication only (the caller has no role yet).
 * The uid comes from the verified token; the body is strict (see
 * registerBodySchema). All logic lives in RegistrationService.
 */
export function createRegisterRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  service: RegistrationService = new RegistrationService()
) {
  const router = Router();

  router.post(
    '/register',
    authenticateFirebase(verifier),
    createRateLimiter({
      windowMs: 60_000,
      max: 5,
      keyFor: (req) => req.identity?.firebaseUid,
      message: 'Too many sign-up attempts. Please wait a minute.',
    }),
    validateBody(registerBodySchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const result = await service.register(req.identity!.firebaseUid, req.body as RegisterBody);
      res.status(201).json(result);
    })
  );

  return router;
}
