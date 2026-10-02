import express, { Router } from 'express';

import { asyncHandler } from '../../middleware/asyncHandler';
import { CustomerCallService } from '../../services/customerCallService';

/**
 * Exotel's call-status callback. Not behind Firebase auth (Exotel is the
 * caller); instead the URL carries an HMAC token we generated per call, which
 * the service verifies in constant time. Always answers 200 with an empty body
 * so a caller probing for valid call ids learns nothing.
 */
export function createExotelWebhookRouter(callService: CustomerCallService = new CustomerCallService()) {
  const router = Router();

  router.post(
    '/call-status',
    express.urlencoded({ extended: false, limit: '20kb' }),
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      try {
        await callService.recordStatus(req.query.callId, req.query.t, {
          status: body.Status,
          durationSeconds: body.ConversationDuration ?? body.Duration,
        });
      } catch {
        console.warn('Exotel call-status webhook: could not record a status');
      }
      res.status(200).end();
    })
  );

  return router;
}
