import { Router } from 'express';
import { z } from 'zod';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticateFirebase } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorize';
import { requireActiveDriver } from '../../middleware/requireActiveDriver';
import { resolveRole } from '../../middleware/resolveRole';
import { validateBody } from '../../middleware/validateBody';
import { DriverDutyService } from '../../services/driverDutyService';
import { DriverService } from '../../services/driverService';
import { DuoFaceRoleResolver } from '../../services/roleResolver';
import type { RoleResolver } from '../../services/roleResolver';
import type { AuthenticatedRequest } from '../../types/auth';

// `.strict()`: a client-sent driverId (or anything else) is a 400. The driver
// is always the authenticated one.
const dutyBodySchema = z.object({ onDuty: z.boolean() }).strict();

export function createDriverDutyRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  roleResolver: RoleResolver = new DuoFaceRoleResolver(),
  driverService: DriverService = new DriverService(),
  dutyService: DriverDutyService = new DriverDutyService(driverService)
) {
  const router = Router();

  const guard = [
    authenticateFirebase(verifier),
    resolveRole(roleResolver),
    requireRole('driver'),
    requireActiveDriver(driverService),
  ];

  router.get(
    '/',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json(await dutyService.getDuty(req.driver!.driverId));
    })
  );

  router.put(
    '/',
    ...guard,
    validateBody(dutyBodySchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const { onDuty } = req.body as z.infer<typeof dutyBodySchema>;
      res.json(await dutyService.setDuty(req.driver!.driverId, onDuty));
    })
  );

  return router;
}
