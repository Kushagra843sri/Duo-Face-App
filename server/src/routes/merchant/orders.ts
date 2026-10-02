import { Router } from 'express';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticateFirebase } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorize';
import { requireActiveMerchantShop } from '../../middleware/requireActiveMerchantShop';
import { resolveRole } from '../../middleware/resolveRole';
import { DuoFaceShopService } from '../../services/duoFaceShopService';
import { DeliveryAssignmentService } from '../../services/deliveryAssignmentService';
import { MerchantOrderService } from '../../services/merchantOrderService';
import { DuoFaceRoleResolver } from '../../services/roleResolver';
import type { RoleResolver } from '../../services/roleResolver';
import type { AuthenticatedRequest } from '../../types/auth';

/**
 * shopId/customerAppShopId always come from req.shop (verified + active +
 * linked, resolved server-side) — never from the client. No route here
 * has a :shopId segment, and no body/query field is ever read for it.
 *
 * PATCH /merchant/orders/:orderId/status is intentionally not implemented:
 * no reusable Customer App order status-transition mechanism exists (see
 * docs/decisions/011-merchant-order-boundary.md) — inventing one was
 * explicitly out of scope for this phase.
 */
export function createMerchantOrdersRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  roleResolver: RoleResolver = new DuoFaceRoleResolver(),
  shopService: DuoFaceShopService = new DuoFaceShopService(),
  orderService: MerchantOrderService = new MerchantOrderService(),
  assignmentService: DeliveryAssignmentService = new DeliveryAssignmentService()
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
      const [orders, assignments] = await Promise.all([
        orderService.listOrders(req.shop!),
        assignmentService.latestAssignmentsByOrder(req.shop!),
      ]);
      res.json(orders.map((order) => ({ ...order, deliveryAssignment: assignments.get(order.orderId) ?? null })));
    })
  );

  router.get(
    '/:orderId',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const order = await orderService.getOrder(req.shop!, req.params.orderId);
      if (!order) {
        res.status(404).json({ error: 'not_found', message: 'Order not found.' });
        return;
      }
      const assignments = await assignmentService.latestAssignmentsByOrder(req.shop!);
      res.json({ ...order, deliveryAssignment: assignments.get(order.orderId) ?? null });
    })
  );

  return router;
}
