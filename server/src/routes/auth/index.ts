import { Router } from 'express';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { authenticateFirebase } from '../../middleware/authenticate';
import { resolveRole } from '../../middleware/resolveRole';
import { DuoFaceRoleResolver } from '../../services/roleResolver';
import type { RoleResolver } from '../../services/roleResolver';
import type { AuthenticatedRequest } from '../../types/auth';

export function createAuthRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  roleResolver: RoleResolver = new DuoFaceRoleResolver()
) {
  const router = Router();

  router.get(
    '/me',
    authenticateFirebase(verifier),
    resolveRole(roleResolver),
    (req: AuthenticatedRequest, res) => {
      res.json(req.principal);
    }
  );

  return router;
}
