import { FirestoreCustomerAppOrderProvider } from '../integrations/customerApp/FirestoreCustomerAppOrderProvider';
import type { CustomerAppOrderProvider } from '../integrations/customerApp/CustomerAppOrderProvider';
import { FirestoreNotificationDeviceStore, FirestoreNotificationEventStore } from '../integrations/firebase/FirestoreNotificationStores';
import type { NotificationDeviceStore, NotificationEventStore } from '../integrations/firebase/FirestoreNotificationStores';
import { createPushNotificationProvider } from '../integrations/notifications/createPushNotificationProvider';
import type { PushMessage, PushNotificationProvider } from '../integrations/notifications/PushNotificationProvider';
import { notificationDeviceSchema, notificationEventSchema } from '../types/notifications';
import type { NotificationType } from '../types/notifications';

export type NotifyResult =
  | 'sent' // at least one device accepted it
  | 'no_devices' // recipient has no active device (recorded as done)
  | 'disabled' // provider switched off
  | 'duplicate' // this logical event was already sent / is in flight
  | 'skipped_inconsistent' // order/assignment mismatch: nobody is notified
  | 'failed'; // provider failed for every device; retryable by a later trigger

/** Static, PII-free copy. Nothing order- or person-specific is ever interpolated. */
const CONTENT: Record<NotificationType, { title: string; body: string }> = {
  delivery_assigned: { title: 'Delivery partner assigned', body: 'A delivery partner has been assigned to your order.' },
  delivery_accepted: { title: 'Delivery confirmed', body: 'Your delivery partner has accepted your order.' },
  driver_picked_up: { title: 'Order picked up', body: 'Your order is on its way.' },
  delivery_completed: { title: 'Order delivered', body: 'Your order has been delivered.' },
};

/** A crashed sender leaves state 'sending'; after this long another trigger may take over. */
const SENDING_STALE_MS = 2 * 60 * 1000;

/** Date or Firestore Timestamp -> epoch ms (0 if unknown, i.e. treated as stale). */
function toMillis(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().getTime();
  }
  return 0;
}

interface AssignmentRef {
  orderId: string;
  customerAppShopId: string;
}

/**
 * Customer notifications for delivery lifecycle events.
 *
 * Recipient = the Customer App order's `customerId` (the customer's Firebase
 * UID, as established in decision 023) -> their active devices. Never a
 * driver, merchant, phone number or address. Payload = {type, orderId} only.
 *
 * Idempotency: one durable event per `${type}:${orderId}`, claimed
 * atomically before sending, so retries and duplicate triggers do not
 * produce duplicate pushes (multiple devices of the same customer each get
 * the one logical notification). Never throws: notification trouble must
 * not affect delivery state.
 */
export class NotificationService {
  constructor(
    private readonly orders: CustomerAppOrderProvider = new FirestoreCustomerAppOrderProvider(),
    private readonly devices: NotificationDeviceStore = new FirestoreNotificationDeviceStore(),
    private readonly events: NotificationEventStore = new FirestoreNotificationEventStore(),
    private readonly provider: PushNotificationProvider = createPushNotificationProvider(),
    private readonly now: () => Date = () => new Date()
  ) {}

  async notify(type: NotificationType, assignment: AssignmentRef): Promise<NotifyResult> {
    const { orderId } = assignment;
    try {
      if (!this.provider.enabled) return 'disabled';

      const customerUid = await this.resolveRecipient(assignment);
      if (!customerUid) return 'skipped_inconsistent';

      const eventId = `${type}:${orderId}`;
      if (!(await this.claim(eventId, type, orderId))) return 'duplicate';

      const devices = await this.activeDevices(customerUid);
      if (devices.length === 0) {
        await this.finish(eventId, type, orderId, 'sent', 0);
        return 'no_devices';
      }

      const content = CONTENT[type];
      const messages: PushMessage[] = devices.map((device) => ({
        token: device.pushToken,
        title: content.title,
        body: content.body,
        data: { type, orderId },
      }));

      let results;
      try {
        results = await this.provider.send(messages);
      } catch {
        await this.finish(eventId, type, orderId, 'failed', 0, 'provider_failure');
        console.warn(`NotificationService: ${type} for order ${orderId} failed (provider_failure)`);
        return 'failed';
      }

      // Devices whose token FCM says is dead are switched off, so we stop sending to them.
      await Promise.all(
        results.map(async (result, index) => {
          if (result === 'invalid_token') await this.disable(devices[index]);
        })
      );

      const deliveredCount = results.filter((r) => r === 'sent').length;
      const allFailed = results.length > 0 && results.every((r) => r === 'failed');
      if (allFailed) {
        await this.finish(eventId, type, orderId, 'failed', 0, 'provider_failure');
        console.warn(`NotificationService: ${type} for order ${orderId} failed (provider_failure)`);
        return 'failed';
      }
      await this.finish(eventId, type, orderId, 'sent', deliveredCount);
      return 'sent';
    } catch {
      console.warn(`NotificationService: ${type} for order ${orderId} not sent (internal error)`);
      return 'failed';
    }
  }

  /** order.customerId, after checking the order really belongs to this assignment. */
  private async resolveRecipient(assignment: AssignmentRef): Promise<string | null> {
    const raw = (await this.orders.getOrderById(assignment.orderId)) as
      | { orderId?: unknown; shopId?: unknown; customerId?: unknown }
      | null;
    if (
      !raw ||
      raw.orderId !== assignment.orderId ||
      raw.shopId !== assignment.customerAppShopId ||
      typeof raw.customerId !== 'string' ||
      raw.customerId.length === 0
    ) {
      return null;
    }
    return raw.customerId;
  }

  private async claim(eventId: string, type: NotificationType, orderId: string): Promise<boolean> {
    const now = this.now();
    return this.events.transact(eventId, (current) => {
      const parsed = current ? notificationEventSchema.safeParse(current) : null;
      if (parsed?.success) {
        const event = parsed.data;
        if (event.state === 'sent') return { result: false };
        const updatedAt = toMillis(event.updatedAt);
        if (event.state === 'sending' && now.getTime() - updatedAt < SENDING_STALE_MS) return { result: false };
        return { write: { ...event, state: 'sending', attempts: event.attempts + 1, updatedAt: now }, result: true };
      }
      return {
        write: { eventId, type, orderId, state: 'sending', attempts: 1, createdAt: now, updatedAt: now },
        result: true,
      };
    });
  }

  private async finish(
    eventId: string,
    type: NotificationType,
    orderId: string,
    state: 'sent' | 'failed',
    deliveredCount: number,
    category?: string
  ): Promise<void> {
    const now = this.now();
    const current = await this.events.transact(eventId, (existing) => ({ result: existing }));
    const parsed = notificationEventSchema.safeParse(current);
    await this.events.set(eventId, {
      eventId,
      type,
      orderId,
      state,
      attempts: parsed.success ? parsed.data.attempts : 1,
      deliveredCount,
      ...(category ? { lastErrorCategory: category } : {}),
      createdAt: parsed.success ? parsed.data.createdAt : now,
      updatedAt: now,
    });
  }

  private async activeDevices(firebaseUid: string) {
    const raw = await this.devices.listByFirebaseUid(firebaseUid);
    return raw
      .map((doc) => notificationDeviceSchema.safeParse(doc))
      .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
      .filter((device) => device.status === 'active' && device.firebaseUid === firebaseUid);
  }

  private async disable(device: { deviceId: string; firebaseUid: string; platform: string; pushToken: string; createdAt?: unknown }) {
    await this.devices.set(device.deviceId, { ...device, status: 'disabled', updatedAt: this.now() });
  }
}
