import { Router } from 'express';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticateFirebase } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorize';
import { requireActiveMerchantShop } from '../../middleware/requireActiveMerchantShop';
import { resolveRole } from '../../middleware/resolveRole';
import { DuoFaceShopService } from '../../services/duoFaceShopService';
import { MerchantProductCatalogService } from '../../services/merchantProductCatalogService';
import { DuoFaceRoleResolver } from '../../services/roleResolver';
import type { RoleResolver } from '../../services/roleResolver';
import type { AuthenticatedRequest } from '../../types/auth';

export function createMerchantProductsRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  roleResolver: RoleResolver = new DuoFaceRoleResolver(),
  shopService: DuoFaceShopService = new DuoFaceShopService(),
  catalogService: MerchantProductCatalogService = new MerchantProductCatalogService()
) {
  const router = Router();

  // shopId comes exclusively from req.shop (verified + active, set by
  // requireActiveMerchantShop) — never from the request.
  router.get(
    '/',
    authenticateFirebase(verifier),
    resolveRole(roleResolver),
    requireRole('merchant'),
    requireActiveMerchantShop(shopService),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const entries = await catalogService.listCatalog(req.shop!);
      res.json(entries);
    })
  );

  return router;
}
