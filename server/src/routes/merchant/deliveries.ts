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
import { DeliveryAssignmentService } from '../../services/deliveryAssignmentService';
import { DriverDispatchService } from '../../services/driverDispatchService';
import { DeliveryOrderService } from '../../services/deliveryOrderService';
import { DuoFaceShopService } from '../../services/duoFaceShopService';
import { DuoFaceRoleResolver } from '../../services/roleResolver';
import type { RoleResolver } from '../../services/roleResolver';
import type { AuthenticatedRequest } from '../../types/auth';

// The merchant only names the order. `.strict()` rejects a client-sent
// driverId (or shopId) with 400: drivers are never chosen by the client
// (docs/decisions/026).
const requestDriverBodySchema = z
  .object({
    orderId: z.string().min(1),
  })
  .strict();

/**
 * customerAppShopId always comes from req.shop (verified + active + linked,
 * resolved server-side) — never from the client, including via POST /'s
 * body (see docs/decisions/014).
 */
export function createMerchantDeliveriesRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  roleResolver: RoleResolver = new DuoFaceRoleResolver(),
  shopService: DuoFaceShopService = new DuoFaceShopService(),
  assignmentService: DeliveryAssignmentService = new DeliveryAssignmentService(),
  deliveryOrderService: DeliveryOrderService = new DeliveryOrderService(assignmentService),
  dispatchService: DriverDispatchService = new DriverDispatchService(assignmentService)
) {
  const router = Router();

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
      const assignments = await assignmentService.listMerchantDeliveries(req.shop!);
      res.json(assignments);
    })
  );

  router.post(
    '/',
    ...guard,
    validateBody(requestDriverBodySchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const { orderId } = req.body as z.infer<typeof requestDriverBodySchema>;
      const assignment = await dispatchService.requestDriver(req.shop!, orderId);
      res.status(201).json(await assignmentService.toMerchantDelivery(assignment));
    })
  );

  router.get(
    '/:assignmentId/order',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json(await deliveryOrderService.getForMerchantShop(req.shop!, req.params.assignmentId));
    })
  );

  router.get(
    '/:assignmentId',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const assignment = await assignmentService.getMerchantDelivery(req.shop!, req.params.assignmentId);
      if (!assignment) {
        res.status(404).json({ error: 'not_found', message: 'Assignment not found.' });
        return;
      }
      res.json(assignment);
    })
  );

  return router;
}
