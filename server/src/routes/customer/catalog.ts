import { Router } from 'express';
import type { RequestHandler } from 'express';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticateFirebase } from '../../middleware/authenticate';
import { createRateLimiter } from '../../middleware/rateLimit';
import { CustomerCatalogService } from '../../services/customerCatalogService';

export const CUSTOMER_CATALOG_RATE_LIMIT = { windowMs: 60_000, max: 120 };

/** Browse shops and products. Firebase-authenticated customers only; no Duo-Face role. */
export function createCustomerCatalogRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  service: CustomerCatalogService = new CustomerCatalogService(),
  limiter: RequestHandler = createRateLimiter({
    ...CUSTOMER_CATALOG_RATE_LIMIT,
    keyFor: (req) => req.identity?.firebaseUid,
  }) as RequestHandler
) {
  const router = Router();
  router.use(authenticateFirebase(verifier), limiter);

  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      res.json({ shops: await service.listShops() });
    })
  );

  router.get(
    '/:shopId/products',
    asyncHandler(async (req, res) => {
      res.json({ products: await service.listProducts(req.params.shopId) });
    })
  );

  return router;
}
