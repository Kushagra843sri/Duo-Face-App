import AsyncStorage from '@react-native-async-storage/async-storage';
import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth, initializeAuth } from 'firebase/auth';
import type { Auth, Persistence } from 'firebase/auth';
import { Platform } from 'react-native';

import { env } from '@/lib/env';

/**
 * The single place the Firebase client is initialized. Returns null when
 * the EXPO_PUBLIC_FIREBASE_* config is absent. Auth persistence is left to
 * the SDK: IndexedDB/localStorage on web, AsyncStorage on native — the app
 * never stores tokens itself.
 */
export function getFirebaseAuth(): Auth | null {
  if (!env.firebase) return null;

  const app = getApps().length > 0 ? getApp() : initializeApp(env.firebase);

  if (Platform.OS === 'web') {
    return getAuth(app);
  }

  // getReactNativePersistence only exists in Firebase's React Native build
  // (Metro resolves the "react-native" entry) and is missing from the
  // default TypeScript typings, so it's required lazily on native only.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getReactNativePersistence } = require('firebase/auth') as {
    getReactNativePersistence: (storage: typeof AsyncStorage) => Persistence;
  };

  try {
    return initializeAuth(app, { persistence: getReactNativePersistence(AsyncStorage) });
  } catch {
    // Already initialized (fast refresh) — reuse it.
    return getAuth(app);
  }
}
