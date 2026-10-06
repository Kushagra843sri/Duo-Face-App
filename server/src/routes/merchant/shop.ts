import { Router } from 'express';
import { z } from 'zod';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticateFirebase } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorize';
import { requireActiveMerchantShop } from '../../middleware/requireActiveMerchantShop';
import { resolveRole } from '../../middleware/resolveRole';
import { validateBody } from '../../middleware/validateBody';
import { DuoFaceShopService } from '../../services/duoFaceShopService';
import { DuoFaceRoleResolver } from '../../services/roleResolver';
import type { RoleResolver } from '../../services/roleResolver';
import { ShopListingService } from '../../services/shopListingService';
import type { AuthenticatedRequest } from '../../types/auth';

const openBodySchema = z.object({ isOpen: z.boolean() }).strict();

/**
 * The owner's view of how their shop appears to customers. The shop is always
 * the authenticated merchant's own (req.shop); no id is read from the request.
 */
export function createMerchantShopRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  roleResolver: RoleResolver = new DuoFaceRoleResolver(),
  shopService: DuoFaceShopService = new DuoFaceShopService(),
  listing: ShopListingService = new ShopListingService()
) {
  const router = Router();
  const guard = [authenticateFirebase(verifier), resolveRole(roleResolver), requireRole('merchant'), requireActiveMerchantShop(shopService)];

  router.get(
    '/',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const view = await listing.get(req.shop!.customerAppShopId);
      res.json({ shopId: req.shop!.shopId, name: req.shop!.name, ...view });
    })
  );

  router.put(
    '/open',
    ...guard,
    validateBody(openBodySchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const view = await listing.setOpen(req.shop!.customerAppShopId, (req.body as z.infer<typeof openBodySchema>).isOpen);
      res.json({ shopId: req.shop!.shopId, name: req.shop!.name, ...view });
    })
  );

  return router;
}
