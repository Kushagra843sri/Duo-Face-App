import { Router } from 'express';
import type { RequestHandler } from 'express';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticateFirebase } from '../../middleware/authenticate';
import { createRateLimiter } from '../../middleware/rateLimit';
import { validateBody } from '../../middleware/validateBody';
import { CustomerAddressService } from '../../services/customerAddressService';
import type { AuthenticatedRequest } from '../../types/auth';
import { addressBodySchema, addressPatchSchema } from '../../types/customerOrder';
import type { AddressBody, AddressPatch } from '../../types/customerOrder';

export const CUSTOMER_ADDRESS_RATE_LIMIT = { windowMs: 60_000, max: 60 };

/** The customer's own address book; the uid is only ever the verified token's. */
export function createCustomerAddressesRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  service: CustomerAddressService = new CustomerAddressService(),
  limiter: RequestHandler = createRateLimiter({
    ...CUSTOMER_ADDRESS_RATE_LIMIT,
    keyFor: (req) => req.identity?.firebaseUid,
  }) as RequestHandler
) {
  const router = Router();
  router.use(authenticateFirebase(verifier), limiter);

  router.get(
    '/',
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json({ addresses: await service.list(req.identity!.firebaseUid) });
    })
  );

  router.post(
    '/',
    validateBody(addressBodySchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.status(201).json({ address: await service.create(req.identity!.firebaseUid, req.body as AddressBody) });
    })
  );

  router.patch(
    '/:addressId',
    validateBody(addressPatchSchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      res.json({
        address: await service.update(req.identity!.firebaseUid, req.params.addressId, req.body as AddressPatch),
      });
    })
  );

  router.delete(
    '/:addressId',
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      await service.remove(req.identity!.firebaseUid, req.params.addressId);
      res.status(204).end();
    })
  );

  return router;
}
