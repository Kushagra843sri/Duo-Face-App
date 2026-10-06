import { FirestoreInboxStore } from '../integrations/firebase/FirestoreInboxStore';
import type { InboxStore } from '../integrations/firebase/FirestoreInboxStore';
import { FirestoreNotificationDeviceStore } from '../integrations/firebase/FirestoreNotificationStores';
import type { NotificationDeviceStore } from '../integrations/firebase/FirestoreNotificationStores';
import { createPushNotificationProvider } from '../integrations/notifications/createPushNotificationProvider';
import type { PushNotificationProvider } from '../integrations/notifications/PushNotificationProvider';
import { AppError } from '../middleware/errorHandler';
import { notificationDeviceSchema } from '../types/notifications';
import type { AppNotificationType, InboxItemView } from '../types/notifications';

/**
 * Static, personal-data-free copy for every notification. Nothing order- or
 * person-specific (address, phone, amount, name) is ever interpolated: a push
 * shows on a lock screen.
 */
export const NOTIFICATION_COPY: Record<AppNotificationType, { title: string; body: string }> = {
  // original customer delivery events
  delivery_assigned: { title: 'Delivery partner assigned', body: 'A delivery partner has been assigned to your order.' },
  delivery_accepted: { title: 'Delivery confirmed', body: 'Your delivery partner has accepted your order.' },
  driver_picked_up: { title: 'Order picked up', body: 'Your order is on its way.' },
  delivery_completed: { title: 'Order delivered', body: 'Your order has been delivered.' },
  // customer
  payment_confirmed: { title: 'Payment received', body: 'Your payment was successful. The shop will start on your order.' },
  order_confirmed: { title: 'Order confirmed', body: 'The shop accepted your order.' },
  order_rejected: { title: 'Order declined', body: "The shop couldn't take your order. If you paid online, you'll be refunded." },
  order_cancelled_unpaid: { title: 'Order cancelled', body: 'Your order was cancelled because the payment was not completed in time.' },
  driver_nearby: { title: 'Your delivery partner is nearby', body: 'Get your delivery code ready: your order will arrive shortly.' },
  refund_started: { title: 'Refund started', body: 'We have started your refund. It can take a few days to reach your account.' },
  refund_completed: { title: 'Refund completed', body: 'Your refund has been sent to your original payment method.' },
  // merchant
  new_order: { title: 'New order', body: 'You have a new order. Open the app to accept it.' },
  order_cancelled_by_customer: { title: 'Order cancelled', body: 'A customer cancelled an order before you accepted it.' },
  shop_driver_accepted: { title: 'Delivery partner on the way', body: 'A delivery partner accepted the pickup for an order.' },
  shop_driver_picked_up: { title: 'Order picked up', body: 'A delivery partner picked up an order.' },
  // driver
  new_delivery_offer: { title: 'New delivery offer', body: 'You have a new delivery request. Open the app to accept it.' },
  // merchant + driver
  kyc_approved: { title: 'Verification approved', body: 'Your documents were verified.' },
  kyc_rejected: { title: 'Verification needs changes', body: 'Your documents need an update. Open your profile to see why.' },
  // admin
  admin_refund_due: { title: 'Refund needed', body: 'An order needs a refund. Open the app to review it.' },
  admin_kyc_submitted: { title: 'Verification to review', body: 'A driver or shop submitted documents for review.' },
};

export interface NotifyInput {
  recipientUid: string;
  type: AppNotificationType;
  /** What this notification is about (order id, assignment id...). Same recipient + type + ref is sent at most once. */
  refId: string;
  orderId?: string;
}

export type NotifyOutcome = 'sent' | 'inbox_only' | 'duplicate' | 'failed';

const MAX_INBOX = 50;

function toDate(value: unknown): Date | null {
  if (Object.prototype.toString.call(value) === '[object Date]') return new Date((value as Date).getTime());
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') return (value as { toDate: () => Date }).toDate();
  return null;
}

/**
 * The one way the system tells a person something. Two steps per
 * notification: (1) write it to the recipient's inbox, which is also the
 * once-only guard; (2) push it to their registered devices. The inbox is the
 * source of truth: push is best effort (it does not exist on web, Expo Go or
 * iOS yet), so a failed push never loses the notification. Never throws:
 * notification trouble must not affect orders, payments or refunds.
 */
export class Notifier {
  constructor(
    private readonly inbox: InboxStore = new FirestoreInboxStore(),
    private readonly devices: NotificationDeviceStore = new FirestoreNotificationDeviceStore(),
    private readonly provider: PushNotificationProvider = createPushNotificationProvider(),
    private readonly now: () => Date = () => new Date()
  ) {}

  async notify(input: NotifyInput): Promise<NotifyOutcome> {
    try {
      const copy = NOTIFICATION_COPY[input.type];
      const id = `${input.type}:${input.refId}`;
      const created = await this.inbox.create(input.recipientUid, id, {
        type: input.type,
        title: copy.title,
        body: copy.body,
        orderId: input.orderId ?? null,
        createdAt: this.now(),
        readAt: null,
      });
      if (!created) return 'duplicate';
      return (await this.push(input)) ? 'sent' : 'inbox_only';
    } catch {
      console.warn(`Notifier: ${input.type} could not be recorded`);
      return 'failed';
    }
  }

  private async push(input: NotifyInput): Promise<boolean> {
    if (!this.provider.enabled) return false;
    try {
      const raw = await this.devices.listByFirebaseUid(input.recipientUid);
      const devices = raw
        .map((doc) => notificationDeviceSchema.safeParse(doc))
        .flatMap((p) => (p.success ? [p.data] : []))
        .filter((d) => d.status === 'active' && d.firebaseUid === input.recipientUid);
      if (devices.length === 0) return false;

      const copy = NOTIFICATION_COPY[input.type];
      const results = await this.provider.send(
        devices.map((d) => ({
          token: d.pushToken,
          title: copy.title,
          body: copy.body,
          data: { type: input.type, ...(input.orderId ? { orderId: input.orderId } : {}) },
        }))
      );
      // A token FCM says is dead is switched off so we stop sending to it.
      await Promise.all(
        results.map(async (result, i) => {
          if (result === 'invalid_token') await this.devices.set(devices[i].deviceId, { ...devices[i], status: 'disabled', updatedAt: this.now() });
        })
      );
      return results.some((r) => r === 'sent');
    } catch {
      console.warn(`Notifier: push for ${input.type} failed`);
      return false;
    }
  }

  // ---- inbox reads (the recipient's own uid only, always from the verified token) ----

  async list(uid: string): Promise<{ notifications: InboxItemView[]; unread: number }> {
    const [rows, unread] = await Promise.all([this.inbox.list(uid, MAX_INBOX), this.inbox.unreadCount(uid)]);
    return { notifications: rows.flatMap((row) => this.toView(row)), unread };
  }

  async markRead(uid: string, id: string): Promise<void> {
    if (!(await this.inbox.markRead(uid, id, this.now()))) throw new AppError(404, 'Notification not found.');
  }

  async markAllRead(uid: string): Promise<{ marked: number }> {
    return { marked: await this.inbox.markAllRead(uid, this.now()) };
  }

  private toView(row: Record<string, unknown>): InboxItemView[] {
    const created = toDate(row.createdAt);
    // Skip anything malformed or written by a newer version with a type this server does not know.
    if (!created || typeof row.type !== 'string' || !(row.type in NOTIFICATION_COPY)) return [];
    return [
      {
        id: String(row.id),
        type: row.type as AppNotificationType,
        title: String(row.title ?? ''),
        body: String(row.body ?? ''),
        orderId: typeof row.orderId === 'string' ? row.orderId : null,
        createdAt: created.toISOString(),
        read: row.readAt != null,
      },
    ];
  }
}
