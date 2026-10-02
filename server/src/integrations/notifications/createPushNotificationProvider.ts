import { FcmPushNotificationProvider } from './FcmPushNotificationProvider';
import { NoopPushNotificationProvider } from './PushNotificationProvider';
import type { PushNotificationProvider } from './PushNotificationProvider';

/**
 * Opt-in: real pushes are attempted only when PUSH_NOTIFICATIONS_ENABLED=true
 * (and Firebase Admin credentials exist). Otherwise nothing is sent.
 */
export function createPushNotificationProvider(source: NodeJS.ProcessEnv = process.env): PushNotificationProvider {
  return source.PUSH_NOTIFICATIONS_ENABLED === 'true' ? new FcmPushNotificationProvider() : new NoopPushNotificationProvider();
}
