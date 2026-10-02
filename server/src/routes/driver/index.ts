import { Router } from 'express';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { authenticateFirebase } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorize';
import { requireActiveDriver } from '../../middleware/requireActiveDriver';
import { resolveRole } from '../../middleware/resolveRole';
import { DriverService } from '../../services/driverService';
import { DuoFaceRoleResolver } from '../../services/roleResolver';
import type { RoleResolver } from '../../services/roleResolver';
import type { AuthenticatedRequest } from '../../types/auth';

export function createDriverRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  roleResolver: RoleResolver = new DuoFaceRoleResolver(),
  driverService: DriverService = new DriverService()
) {
  const router = Router();

  router.get(
    '/me',
    authenticateFirebase(verifier),
    resolveRole(roleResolver),
    requireRole('driver'),
    requireActiveDriver(driverService),
    (req: AuthenticatedRequest, res) => {
      res.json({
        firebaseUid: req.principal!.firebaseUid,
        role: 'driver',
        driverId: req.driver!.driverId,
        name: req.driver!.name,
        ...(req.driver!.phoneNumber ? { phoneNumber: req.driver!.phoneNumber } : {}),
        status: req.driver!.status,
      });
    }
  );

  return router;
}
