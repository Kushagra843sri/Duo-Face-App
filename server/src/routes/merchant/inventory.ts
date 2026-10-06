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
import { InventoryService } from '../../services/inventoryService';
import { DuoFaceRoleResolver } from '../../services/roleResolver';
import type { RoleResolver } from '../../services/roleResolver';
import type { AuthenticatedRequest } from '../../types/auth';
import { stockKey } from '../../types/duoFaceShop';

const createInventorySchema = z.object({
  productId: z.string().min(1),
  quantity: z.number().int().min(0),
});

const setQuantitySchema = z.object({
  quantity: z.number().int().min(0),
});

const adjustQuantitySchema = z.object({
  delta: z.number().int().refine((value) => value !== 0, { message: 'delta must be a non-zero integer' }),
});

export function createMerchantInventoryRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  roleResolver: RoleResolver = new DuoFaceRoleResolver(),
  shopService: DuoFaceShopService = new DuoFaceShopService(),
  inventoryService: InventoryService = new InventoryService()
) {
  const router = Router();

  // shopId always comes from req.shop (verified + active by
  // requireActiveMerchantShop) — never from the request body, query, or
  // params. None of these routes even have a :shopId segment.
  const guard = [
    authenticateFirebase(verifier),
    resolveRole(roleResolver),
    requireRole('merchant'),
    requireActiveMerchantShop(shopService),
  ];

  router.get(
    '/',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const items = await inventoryService.listInventory(stockKey(req.shop!));
      res.json(items);
    })
  );

  router.get(
    '/:productId',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const item = await inventoryService.getInventory(stockKey(req.shop!), req.params.productId);
      if (!item) {
        res.status(404).json({ error: 'not_found', message: 'Inventory not found for this product.' });
        return;
      }
      res.json(item);
    })
  );

  router.post(
    '/',
    ...guard,
    validateBody(createInventorySchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const { productId, quantity } = req.body as z.infer<typeof createInventorySchema>;
      const item = await inventoryService.createInventory(stockKey(req.shop!), productId, quantity);
      res.status(201).json(item);
    })
  );

  router.patch(
    '/:productId/quantity',
    ...guard,
    validateBody(setQuantitySchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const { quantity } = req.body as z.infer<typeof setQuantitySchema>;
      const item = await inventoryService.setQuantity(stockKey(req.shop!), req.params.productId, quantity);
      res.json(item);
    })
  );

  router.post(
    '/:productId/adjust',
    ...guard,
    validateBody(adjustQuantitySchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const { delta } = req.body as z.infer<typeof adjustQuantitySchema>;
      const item = await inventoryService.adjustQuantity(stockKey(req.shop!), req.params.productId, delta);
      res.json(item);
    })
  );

  router.patch(
    '/:productId/disable',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const item = await inventoryService.disableInventory(stockKey(req.shop!), req.params.productId);
      res.json(item);
    })
  );

  return router;
}
