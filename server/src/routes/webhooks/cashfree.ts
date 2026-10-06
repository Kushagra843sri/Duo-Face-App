import { Router } from 'express';
import type { Request } from 'express';

import { asyncHandler } from '../../middleware/asyncHandler';
import { AppError } from '../../middleware/errorHandler';
import { PaymentService } from '../../services/paymentService';

/** The exact bytes Cashfree sent: the signature is over these, not over re-serialised JSON. */
export interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

/**
 * Cashfree posts payment events here. A bad signature is 401 and changes
 * nothing. A valid one is still re-confirmed against Cashfree's API before an
 * order is marked paid (PaymentService.handleWebhook). A temporary failure
 * answers 5xx so Cashfree retries.
 */
export function createCashfreeWebhookRouter(service: PaymentService) {
  const router = Router();

  router.post(
    '/',
    asyncHandler(async (req: RawBodyRequest, res) => {
      const timestamp = req.header('x-webhook-timestamp');
      const signature = req.header('x-webhook-signature');
      if (!req.rawBody || !timestamp || !signature) throw new AppError(401, 'Missing webhook signature.');
      await service.handleWebhook(req.rawBody.toString('utf8'), timestamp, signature);
      res.json({ status: 'ok' });
    })
  );

  return router;
}
