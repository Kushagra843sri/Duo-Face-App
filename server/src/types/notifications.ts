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

/**
 * Every notification the system can send, to anyone. The first four are the
 * original customer delivery events (NotificationService); the rest go
 * through Notifier and are also kept in the recipient's in-app inbox.
 */
export const appNotificationTypeSchema = z.enum([
  ...notificationTypeSchema.options,
  // customer
  'payment_confirmed',
  'order_confirmed',
  'order_rejected',
  'order_cancelled_unpaid',
  'driver_nearby',
  'refund_started',
  'refund_completed',
  // merchant
  'new_order',
  'order_cancelled_by_customer',
  'shop_driver_accepted',
  'shop_driver_picked_up',
  // driver
  'new_delivery_offer',
  // merchant + driver
  'kyc_approved',
  'kyc_rejected',
  // admin
  'admin_refund_due',
  'admin_kyc_submitted',
]);
export type AppNotificationType = z.infer<typeof appNotificationTypeSchema>;

export const INBOX_COLLECTION = 'duo_face_inbox';

/** What an app shows in its inbox. No addresses, phones, amounts or coordinates, ever. */
export interface InboxItemView {
  id: string;
  type: AppNotificationType;
  title: string;
  body: string;
  orderId: string | null;
  createdAt: string;
  read: boolean;
}
