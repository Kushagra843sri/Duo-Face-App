import { getFirebaseAdminApp } from '../firebase/firebaseAdmin';
import type { PushMessage, PushNotificationProvider, PushResult } from './PushNotificationProvider';

const INVALID_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * Firebase Cloud Messaging via the Admin SDK already used by the server
 * (same project as the Customer App). Credentials stay server-side; the
 * mobile apps only register their FCM token with the API. UNVERIFIED against
 * real FCM in this repo's environment (no project/credentials) — see
 * decision 024.
 */
export class FcmPushNotificationProvider implements PushNotificationProvider {
  readonly enabled = true;

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    if (messages.length === 0) return [];
    const { getMessaging } = await import('firebase-admin/messaging');
    const response = await getMessaging(getFirebaseAdminApp()).sendEach(
      messages.map((message) => ({
        token: message.token,
        notification: { title: message.title, body: message.body },
        data: { type: message.data.type, orderId: message.data.orderId },
      }))
    );

    return response.responses.map((result): PushResult => {
      if (result.success) return 'sent';
      const code = (result.error as { code?: string } | undefined)?.code ?? '';
      return INVALID_TOKEN_CODES.has(code) ? 'invalid_token' : 'failed';
    });
  }
}
