import { z } from 'zod';

export const ORDER_SYNC_COLLECTION = 'duo_face_order_sync';

/** Total attempts (across immediate retries and later sweeps) before a record is left as failed. */
export const MAX_SYNC_ATTEMPTS = 5;

export const orderSyncStateSchema = z.enum(['pending', 'completed', 'failed']);
export type OrderSyncState = z.infer<typeof orderSyncStateSchema>;

/**
 * Categories stored on failure. Never a raw error or external response.
 * Retryable: only `transient_external_failure`. The rest are permanent —
 * retrying would not change the outcome (or, for protected statuses, must
 * never overwrite the Customer App order).
 */
export const orderSyncErrorCategorySchema = z.enum([
  'protected_status',
  'not_found',
  'shop_mismatch',
  'transient_external_failure',
  'permanent_external_failure',
]);
export type OrderSyncErrorCategory = z.infer<typeof orderSyncErrorCategorySchema>;

/**
 * duo_face_order_sync/{orderId}. The document id is the orderId and
 * `targetStatus` is the single supported target ('delivered'). LIMITATION:
 * one record per order means one sync target per order. If another target is
 * ever authorized, the id must become `${orderId}:${targetStatus}` (a
 * migration) rather than reusing this record.
 * Holds no address, phone, payment data, tokens or external responses.
 */
export const orderSyncRecordSchema = z.object({
  orderId: z.string().min(1),
  targetStatus: z.literal('delivered'),
  state: orderSyncStateSchema,
  attempts: z.number().int().min(0),
  lastAttemptAt: z.unknown().optional(),
  completedAt: z.unknown().optional(),
  outcome: z.enum(['delivered', 'already_delivered']).optional(),
  lastErrorCategory: orderSyncErrorCategorySchema.optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
});
export type OrderSyncRecord = z.infer<typeof orderSyncRecordSchema>;

export function buildPendingOrderSyncRecord(orderId: string, now: Date): Record<string, unknown> {
  return { orderId, targetStatus: 'delivered', state: 'pending', attempts: 0, createdAt: now, updatedAt: now };
}
