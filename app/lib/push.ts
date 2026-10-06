import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Notifications from 'expo-notifications';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';

import { apiRequest } from '@/api/client';
import { previewRole } from '@/lib/preview';

const DEVICE_ID_KEY = 'duoface.deviceId.v1';

/** Stable per-install id (the server scopes it to the signed-in uid). */
async function getDeviceId(): Promise<string> {
  try {
    const existing = await AsyncStorage.getItem(DEVICE_ID_KEY);
    if (existing && /^[A-Za-z0-9._-]{1,128}$/.test(existing)) return existing;
  } catch {
    // fall through and make a new one
  }
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  try {
    await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  } catch {
    // an unstored id just means a new registration next launch
  }
  return id;
}

let handlerInstalled = false;

/** Show notifications that arrive while the app is open, too. */
function installForegroundHandler() {
  if (handlerInstalled) return;
  handlerInstalled = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
  });
}

/**
 * Asks for permission and registers this device for notifications (shop,
 * driver and admin alike: the server knows who is signed in). Best effort and
 * silent: it never throws and does nothing where push cannot work (web,
 * preview, Expo Go, iOS until Apple push is set up). The inbox still works
 * everywhere. Only the push token and platform are sent.
 */
export async function registerForPush(): Promise<void> {
  if (previewRole || Platform.OS !== 'android') return;
  try {
    installForegroundHandler();
    await Notifications.setNotificationChannelAsync('default', { name: 'Updates', importance: Notifications.AndroidImportance.DEFAULT });

    const existing = await Notifications.getPermissionsAsync();
    const granted = existing.granted || (await Notifications.requestPermissionsAsync()).granted;
    if (!granted) return;

    const token = await Notifications.getDevicePushTokenAsync();
    if (typeof token.data !== 'string' || token.data.length < 20) return;
    await apiRequest('/notifications/device', {
      method: 'POST',
      body: JSON.stringify({ deviceId: await getDeviceId(), platform: 'android', pushToken: token.data }),
    });
  } catch {
    // Expo Go / no Firebase config / offline: the inbox still shows everything.
  }
}

/** Stops notifications for this device (called on sign-out, while the session is still valid). */
export async function unregisterFromPush(): Promise<void> {
  if (previewRole || Platform.OS !== 'android') return;
  try {
    await apiRequest(`/notifications/device/${encodeURIComponent(await getDeviceId())}`, { method: 'DELETE' });
  } catch {
    // best effort
  }
}

/**
 * Opens the inbox when a push notification is tapped. The push carries only a
 * type and an order id (no personal data); the inbox is the one place that
 * decides where each notification leads.
 */
export function usePushTaps(signedIn: boolean): void {
  const router = useRouter();
  useEffect(() => {
    if (!signedIn || previewRole || Platform.OS !== 'android') return;
    const sub = Notifications.addNotificationResponseReceivedListener(() => router.push('/notifications'));
    return () => sub.remove();
  }, [signedIn, router]);
}
