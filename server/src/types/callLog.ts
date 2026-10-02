import { z } from 'zod';

export const CALL_LOGS_COLLECTION = 'duo_face_call_logs';

export const callStatusSchema = z.enum(['initiated', 'completed', 'failed', 'busy', 'no-answer']);
export type CallStatus = z.infer<typeof callStatusSchema>;

/**
 * duo_face_call_logs/{callId}. An audit/abuse record of a masked call.
 * Deliberately holds NO phone numbers (driver's or customer's) — only ids,
 * the provider's call sid, status and duration.
 */
export const callLogSchema = z.object({
  callId: z.string().min(1),
  assignmentId: z.string().min(1),
  orderId: z.string().min(1),
  driverId: z.string().min(1),
  providerCallSid: z.string().min(1).optional(),
  status: callStatusSchema,
  durationSeconds: z.number().int().min(0).optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
});
export type CallLog = z.infer<typeof callLogSchema>;
