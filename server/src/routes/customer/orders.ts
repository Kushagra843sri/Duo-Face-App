import { Router } from 'express';
import type { RequestHandler } from 'express';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticateFirebase } from '../../middleware/authenticate';
import { createRateLimiter } from '../../middleware/rateLimit';
import { validateBody } from '../../middleware/validateBody';
import { CustomerDeliveryCodeService } from '../../services/customerDeliveryCodeService';
import { CustomerOrderService } from '../../services/customerOrderService';
import { PaymentService } from '../../services/paymentService';
import type { AuthenticatedRequest } from '../../types/auth';
import { placeOrderBodySchema } from '../../types/customerOrder';
import type { PlaceOrderBody } from '../../types/customerOrder';

/** Placing orders is the expensive/abusable action: 10 per minute per customer. */
export const CUSTOMER_PLACE_ORDER_RATE_LIMIT = { windowMs: 60_000, max: 10 };
export const CUSTOMER_ORDER_READ_RATE_LIMIT = { windowMs: 60_000, max: 60 };

/**
 * Customer orders. Authorization is ownership only (order.customerId ===
 * verified uid); customerId, prices and role are never read from the body.
 */
export function createCustomerOrdersRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  service: CustomerOrderService = new CustomerOrderService(),
  placeLimiter: RequestHandler = createRateLimiter({
    ...CUSTOMER_PLACE_ORDER_RATE_LIMIT,
    keyFor: (req) => req.identity?.firebaseUid,
  }) as RequestHandler,
  readLimiter: RequestHandler = createRateLimiter({
    ...CUSTOMER_ORDER_READ_RATE_LIMIT,
    keyFor: (req) => req.identity?.firebaseUid,
  }) as RequestHandler,
  deliveryCodeService: CustomerDeliveryCodeService = new CustomerDeliveryCodeService(),
  paymentService: PaymentService = new PaymentService(service, null, null)
) {
  const router = Router();
  router.use(authenticateFirebase(verifier));

  router.post(
    '/',
    placeLimiter,
    validateBody(placeOrderBodySchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const { order, created } = await service.placeOrder(req.identity!.firebaseUid, req.body as PlaceOrderBody);
      res.status(created ? 201 : 200).json({ order });
    })
  );

  router.get(
    '/',
    readLimiter,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json({ orders: await service.listOrders(req.identity!.firebaseUid) });
    })
  );

  router.get(
    '/:orderId',
    readLimiter,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json({ order: await service.getOrder(req.identity!.firebaseUid, req.params.orderId) });
    })
  );

  router.get(
    '/:orderId/delivery-code',
    readLimiter,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json(await deliveryCodeService.getCode(req.identity!.firebaseUid, req.params.orderId));
    })
  );

  router.post(
    '/:orderId/payment',
    readLimiter,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json(await paymentService.startPayment(req.identity!.firebaseUid, req.params.orderId));
    })
  );

  router.post(
    '/:orderId/payment/verify',
    readLimiter,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json({ order: await paymentService.verify(req.identity!.firebaseUid, req.params.orderId) });
    })
  );

  router.post(
    '/:orderId/cancel',
    readLimiter,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json({ order: await service.cancelOrder(req.identity!.firebaseUid, req.params.orderId) });
    })
  );

  return router;
}
