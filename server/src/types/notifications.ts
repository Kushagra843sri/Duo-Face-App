import { z } from 'zod';

export const NOTIFICATION_DEVICES_COLLECTION = 'duo_face_notification_devices';
export const NOTIFICATION_EVENTS_COLLECTION = 'duo_face_notification_events';

/** Customer-facing lifecycle notifications. No GPS/location notifications exist. */
export const notificationTypeSchema = z.enum(['delivery_assigned', 'delivery_accepted', 'driver_picked_up', 'delivery_completed']);
export type NotificationType = z.infer<typeof notificationTypeSchema>;

export const devicePlatformSchema = z.enum(['ios', 'android', 'web']);

/** POST /customer/notifications/device — the Firebase UID is never in the body. */
export const registerDeviceBodySchema = z
  .object({
    deviceId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/, 'deviceId must be 1-128 characters of A-Z a-z 0-9 . _ -'),
    platform: devicePlatformSchema,
    pushToken: z.string().min(20).max(4096),
  })
  .strict();
export type RegisterDeviceBody = z.infer<typeof registerDeviceBodySchema>;

/**
 * duo_face_notification_devices/{firebaseUid}:{deviceId}. The id embeds the
 * UID so a client-chosen deviceId can never collide with (or overwrite)
 * another user's device. Holds a push token and platform only: no refresh
 * tokens, credentials, order data or location.
 */
export const notificationDeviceSchema = z.object({
  deviceId: z.string().min(1),
  firebaseUid: z.string().min(1),
  platform: devicePlatformSchema,
  pushToken: z.string().min(1),
  status: z.enum(['active', 'disabled']),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
});
export type NotificationDevice = z.infer<typeof notificationDeviceSchema>;

/**
 * duo_face_notification_events/{type}:{orderId} — one logical event per
 * order and type, so retries cannot fan out duplicates. No tokens, ids of
 * recipients, or content.
 */
export const notificationEventSchema = z.object({
  eventId: z.string().min(1),
  type: notificationTypeSchema,
  orderId: z.string().min(1),
  state: z.enum(['sending', 'sent', 'failed']),
  attempts: z.number().int().min(0),
  deliveredCount: z.number().int().min(0).optional(),
  lastErrorCategory: z.string().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
});
export type NotificationEvent = z.infer<typeof notificationEventSchema>;
