import Constants from 'expo-constants';

/**
 * Backend base URL resolution (Duo-Face API only — the app never talks to
 * Firebase Admin/Firestore):
 *  1. EXPO_PUBLIC_API_URL if set (required for production builds; also the
 *     explicit override in development).
 *  2. Development only: the machine running the Expo dev server, taken from
 *     Expo's own dev-server address (`hostUri`), on EXPO_PUBLIC_API_PORT
 *     (default 4000). This is how a physical phone on the same Wi-Fi reaches
 *     the Express server without a personal IP being written anywhere. It
 *     is never used in production builds.
 *  3. http://localhost:4000 — correct for the web build / simulators on the
 *     same machine, WRONG on a physical phone (localhost is the phone).
 */
function resolveApiUrl(): { url: string; source: 'env' | 'dev-server-host' | 'localhost-fallback' } {
  const explicit = process.env.EXPO_PUBLIC_API_URL;
  if (explicit) return { url: explicit, source: 'env' };

  if (__DEV__) {
    const host = Constants.expoConfig?.hostUri?.split(':')[0];
    if (host) {
      const port = process.env.EXPO_PUBLIC_API_PORT || '4000';
      return { url: `http://${host}:${port}`, source: 'dev-server-host' };
    }
  }
  return { url: 'http://localhost:4000', source: 'localhost-fallback' };
}

const apiUrl = resolveApiUrl();

if (apiUrl.source === 'localhost-fallback') {
  console.warn('EXPO_PUBLIC_API_URL is not set; falling back to http://localhost:4000 (unreachable from a physical phone)');
}

// Client-safe Firebase web config only (these identify the project; they are
// not secrets). Each variable must be referenced statically so Metro can
// inline it at bundle time. Server credentials never belong here.
const firebaseApiKey = process.env.EXPO_PUBLIC_FIREBASE_API_KEY;
const firebaseAuthDomain = process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN;
const firebaseProjectId = process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID;
const firebaseAppId = process.env.EXPO_PUBLIC_FIREBASE_APP_ID;

export const env = {
  apiUrl: apiUrl.url,
  /** null when any required Firebase value is missing — auth is then "not configured", never faked. */
  firebase:
    firebaseApiKey && firebaseAuthDomain && firebaseProjectId && firebaseAppId
      ? {
          apiKey: firebaseApiKey,
          authDomain: firebaseAuthDomain,
          projectId: firebaseProjectId,
          appId: firebaseAppId,
        }
      : null,
};
