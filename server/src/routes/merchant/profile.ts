import { Router } from 'express';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticateFirebase } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorize';
import { requireActiveMerchantShop } from '../../middleware/requireActiveMerchantShop';
import { resolveRole } from '../../middleware/resolveRole';
import { validateBody } from '../../middleware/validateBody';
import { DuoFaceShopService } from '../../services/duoFaceShopService';
import { MerchantProfileService } from '../../services/merchantProfileService';
import { DuoFaceRoleResolver } from '../../services/roleResolver';
import type { RoleResolver } from '../../services/roleResolver';
import type { AuthenticatedRequest } from '../../types/auth';
import { merchantPhotoConfirmSchema, merchantPhotoKindSchema, merchantPhotoUploadSchema, merchantProfileInputSchema } from '../../types/profile';
import type { MerchantProfileInput } from '../../types/profile';
import { addPhotoRoutes } from '../profileRoutes';

/**
 * The shop id always comes from req.shop (verified + active). No :shopId and
 * strict bodies: a client-sent shopId, status or commission is a 400
 * (docs/decisions/029).
 */
export function createMerchantProfileRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  roleResolver: RoleResolver = new DuoFaceRoleResolver(),
  shopService: DuoFaceShopService = new DuoFaceShopService(),
  profileService: MerchantProfileService = new MerchantProfileService(undefined, shopService)
) {
  const router = Router();

  const guard = [authenticateFirebase(verifier), resolveRole(roleResolver), requireRole('merchant'), requireActiveMerchantShop(shopService)];

  router.get(
    '/',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(await profileService.get(req.shop!.shopId));
    })
  );

  router.patch(
    '/',
    ...guard,
    validateBody(merchantProfileInputSchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(await profileService.update(req.shop!.shopId, req.body as MerchantProfileInput));
    })
  );

  addPhotoRoutes(router, guard, {
    photos: profileService.photos,
    ownerId: (req) => req.shop!.shopId,
    uploadSchema: merchantPhotoUploadSchema,
    confirmSchema: merchantPhotoConfirmSchema,
    kinds: merchantPhotoKindSchema.options,
  });

  return router;
}
