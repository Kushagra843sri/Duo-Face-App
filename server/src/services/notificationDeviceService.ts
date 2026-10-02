import { FirestoreNotificationDeviceStore } from '../integrations/firebase/FirestoreNotificationStores';
import type { NotificationDeviceStore } from '../integrations/firebase/FirestoreNotificationStores';
import { notificationDeviceSchema } from '../types/notifications';
import type { RegisterDeviceBody } from '../types/notifications';

export interface RegisteredDevice {
  deviceId: string;
  platform: RegisterDeviceBody['platform'];
  status: 'active' | 'disabled';
}

const docIdFor = (firebaseUid: string, deviceId: string) => `${firebaseUid}:${deviceId}`;

/**
 * The Firebase UID always comes from the verified token (never the body).
 * The stored document id embeds it, so one user can never overwrite another
 * user's device by choosing the same deviceId.
 */
export class NotificationDeviceService {
  constructor(
    private readonly store: NotificationDeviceStore = new FirestoreNotificationDeviceStore(),
    private readonly now: () => Date = () => new Date()
  ) {}

  /** Idempotent: repeating the call, or re-registering with a new token, updates the same document. */
  async register(firebaseUid: string, body: RegisterDeviceBody): Promise<RegisteredDevice> {
    const docId = docIdFor(firebaseUid, body.deviceId);
    const now = this.now();
    const existing = notificationDeviceSchema.safeParse(await this.store.get(docId));

    await this.store.set(docId, {
      deviceId: docId,
      firebaseUid,
      platform: body.platform,
      pushToken: body.pushToken,
      status: 'active',
      createdAt: existing.success ? existing.data.createdAt : now,
      updatedAt: now,
    });

    // A push token identifies one physical install. If another account (or
    // another registration) previously held it, switch that one off so the
    // previous account stops receiving this phone's notifications.
    const sameToken = await this.store.listByPushToken(body.pushToken);
    await Promise.all(
      sameToken
        .map((doc) => notificationDeviceSchema.safeParse(doc))
        .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
        .filter((device) => device.deviceId !== docId && device.status === 'active')
        .map((device) => this.store.set(device.deviceId, { ...device, status: 'disabled', updatedAt: now }))
    );

    return { deviceId: body.deviceId, platform: body.platform, status: 'active' };
  }

  /** Idempotent; only ever touches the caller's own registration. */
  async unregister(firebaseUid: string, deviceId: string): Promise<void> {
    const docId = docIdFor(firebaseUid, deviceId);
    const existing = notificationDeviceSchema.safeParse(await this.store.get(docId));
    if (!existing.success || existing.data.firebaseUid !== firebaseUid) return;
    await this.store.set(docId, { ...existing.data, status: 'disabled', updatedAt: this.now() });
  }
}
