import { Router } from 'express';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { authenticateFirebase } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorize';
import { requireActiveMerchantShop } from '../../middleware/requireActiveMerchantShop';
import { resolveRole } from '../../middleware/resolveRole';
import { DuoFaceShopService } from '../../services/duoFaceShopService';
import { DuoFaceRoleResolver } from '../../services/roleResolver';
import type { RoleResolver } from '../../services/roleResolver';
import type { AuthenticatedRequest } from '../../types/auth';

export function createMerchantRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  roleResolver: RoleResolver = new DuoFaceRoleResolver(),
  shopService: DuoFaceShopService = new DuoFaceShopService()
) {
  const router = Router();

  router.get(
    '/me',
    authenticateFirebase(verifier),
    resolveRole(roleResolver),
    requireRole('merchant'),
    requireActiveMerchantShop(shopService),
    (req: AuthenticatedRequest, res) => {
      res.json({
        firebaseUid: req.principal!.firebaseUid,
        role: 'merchant',
        shopId: req.shop!.shopId,
        shopName: req.shop!.name,
      });
    }
  );

  return router;
}
