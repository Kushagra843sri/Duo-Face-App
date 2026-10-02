import { Router } from 'express';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticateFirebase } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorize';
import { requireActiveDriver } from '../../middleware/requireActiveDriver';
import { resolveRole } from '../../middleware/resolveRole';
import { validateBody } from '../../middleware/validateBody';
import { DriverProfileService } from '../../services/driverProfileService';
import { DriverService } from '../../services/driverService';
import { DuoFaceRoleResolver } from '../../services/roleResolver';
import type { RoleResolver } from '../../services/roleResolver';
import type { AuthenticatedRequest } from '../../types/auth';
import { driverPhotoConfirmSchema, driverPhotoKindSchema, driverPhotoUploadSchema, driverProfileInputSchema } from '../../types/profile';
import type { DriverProfileInput } from '../../types/profile';
import { addPhotoRoutes } from '../profileRoutes';

/**
 * The driver id always comes from req.driver (verified + active). There is no
 * :driverId anywhere and the body schemas are strict, so a client-sent id,
 * status, or commission is a 400 (docs/decisions/029).
 */
export function createDriverProfileRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  roleResolver: RoleResolver = new DuoFaceRoleResolver(),
  driverService: DriverService = new DriverService(),
  profileService: DriverProfileService = new DriverProfileService(undefined, driverService)
) {
  const router = Router();

  const guard = [authenticateFirebase(verifier), resolveRole(roleResolver), requireRole('driver'), requireActiveDriver(driverService)];

  router.get(
    '/',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(await profileService.get(req.driver!.driverId));
    })
  );

  router.patch(
    '/',
    ...guard,
    validateBody(driverProfileInputSchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(await profileService.update(req.driver!.driverId, req.body as DriverProfileInput));
    })
  );

  addPhotoRoutes(router, guard, {
    photos: profileService.photos,
    ownerId: (req) => req.driver!.driverId,
    uploadSchema: driverPhotoUploadSchema,
    confirmSchema: driverPhotoConfirmSchema,
    kinds: driverPhotoKindSchema.options,
  });

  return router;
}
