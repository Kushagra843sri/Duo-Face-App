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
import { MAX_SHOP_IMAGES, ShopImageService } from '../../services/shopImageService';
import type { AuthenticatedRequest } from '../../types/auth';

const confirmSchema = z
  .object({
    publicId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_\-/]+$/),
    version: z.number().int().positive(),
  })
  .strict();

/** The owner's shop photos. The shop is always req.shop (the authenticated merchant's own). */
export function createMerchantShopImagesRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  roleResolver: RoleResolver = new DuoFaceRoleResolver(),
  shopService: DuoFaceShopService = new DuoFaceShopService(),
  images: ShopImageService = new ShopImageService()
) {
  const router = Router();
  const guard = [authenticateFirebase(verifier), resolveRole(roleResolver), requireRole('merchant'), requireActiveMerchantShop(shopService)];

  router.get(
    '/',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.set('Cache-Control', 'no-store');
      res.json({ max: MAX_SHOP_IMAGES, images: await images.list(req.shop!.customerAppShopId) });
    })
  );

  router.post(
    '/upload-signature',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.set('Cache-Control', 'no-store');
      res.json(await images.requestUpload(req.shop!.customerAppShopId));
    })
  );

  router.post(
    '/',
    ...guard,
    validateBody(confirmSchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const body = req.body as z.infer<typeof confirmSchema>;
      res.json({ max: MAX_SHOP_IMAGES, images: await images.add(req.shop!.customerAppShopId, body.publicId, body.version) });
    })
  );

  router.delete(
    '/:imageId',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json({ max: MAX_SHOP_IMAGES, images: await images.remove(req.shop!.customerAppShopId, req.params.imageId) });
    })
  );

  return router;
}
