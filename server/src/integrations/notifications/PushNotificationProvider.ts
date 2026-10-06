import type { AppNotificationType } from '../../types/notifications';

export interface PushMessage {
  token: string;
  title: string;
  body: string;
  /** Minimal by contract: no address, phone, payment, ids of people, or coordinates. */
  data: { type: AppNotificationType; orderId?: string };
}

export type PushResult = 'sent' | 'invalid_token' | 'failed';

/**
 * Delivery channel abstraction (FCM today). Business code depends on this,
 * never on FCM/Expo APIs. Implementations must not log tokens or message
 * contents, and must report per-message results in order.
 */
export interface PushNotificationProvider {
  /** False = notifications are switched off (nothing is attempted or recorded). */
  readonly enabled: boolean;
  send(messages: PushMessage[]): Promise<PushResult[]>;
}

export class NoopPushNotificationProvider implements PushNotificationProvider {
  readonly enabled = false;
  async send(): Promise<PushResult[]> {
    return [];
  }
}

/** Test double; also records what would have been sent. */
export class InMemoryPushNotificationProvider implements PushNotificationProvider {
  readonly enabled = true;
  readonly sent: PushMessage[] = [];
  failWith: 'throw' | PushResult | ((message: PushMessage) => PushResult) | null = null;

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    if (this.failWith === 'throw') throw new Error('provider down');
    return messages.map((message) => {
      const mode = this.failWith;
      const result: PushResult = typeof mode === 'function' ? mode(message) : mode === null || mode === 'throw' ? 'sent' : mode;
      if (result === 'sent') this.sent.push(message);
      return result;
    });
  }
}
