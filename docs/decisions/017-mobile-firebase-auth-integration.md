# 017 — Mobile Firebase authentication integration

Status: implemented (Phase 16) — **web Phone OTP implemented but not yet exercised against a real Firebase project; native Phone OTP not implemented.**

## Client architecture

- SDK: the Firebase JS SDK (`firebase`) plus `@react-native-async-storage/async-storage` (SDK-required auth persistence on native). Chosen because it is the smallest integration that works in the current Expo managed app (web + Expo Go) with no native build step.
- `lib/env.ts` reads client-safe `EXPO_PUBLIC_FIREBASE_*` values (apiKey, authDomain, projectId, appId). If any is missing, `env.firebase` is `null` and auth is *not configured* — the UI says so; nothing is faked.
- `lib/firebase.ts` is the only place Firebase is initialized (web: `getAuth`; native: `initializeAuth` with AsyncStorage persistence).
- `lib/authService.ts`: the existing `AuthService` interface, now implemented by `FirebaseAuthService` (replacing `UnconfiguredAuthService`). API: `signInWithPhone`, `getIdToken`, `getCurrentUser`, `subscribe`, `signOut`, plus `isConfigured` / `isPhoneSignInSupported`. `apiRequest()` is unchanged and still obtains its token via `authService.getIdToken()`.

## Token flow

Firebase sign-in → SDK holds the session → `apiRequest()` calls `authService.getIdToken()` (SDK returns the cached token and refreshes near expiry) → `Authorization: Bearer <ID token>` → server `authenticateFirebase` verifies with the Admin SDK → `resolveRole`.

Tokens are never logged, never put in URLs, never stored by app code; the SDK owns persistence (IndexedDB/localStorage on web, AsyncStorage on native). No custom refresh logic.

## Role resolution / routing

```
no Firebase user      -> PhoneSignIn
Firebase user         -> GET /auth/me
   merchant           -> /(merchant)  (gate: GET /merchant/me)
   driver             -> /(driver)    (gate: GET /driver/me)
   401 / 403          -> "Session expired" / "Account not set up" (+ Retry, Sign out)
   network failure    -> ErrorState with retry
```

The backend is the sole authority on role. The client never selects a role, and nothing role-related is read from local storage. A successful Firebase login does not imply merchant or driver. The former "preview merchant/driver stack" links were removed — they were a fake entry path. The server-side gates still make any direct visit safe (403 without the right role).

`ErrorState` offers "Sign out" on 401/403 so a wrong-role/expired session is never a dead end.

## Phone OTP status and requirements

- **Web:** implemented via `signInWithPhoneNumber` + an invisible `RecaptchaVerifier` (fresh verifier per attempt). Requires the Firebase project to have Phone sign-in enabled, the app's domain in *Authorized domains*, and a web app registered for the config values. Firebase's test phone numbers can be used for development.
- **iOS/Android:** *not implemented.* The JS SDK cannot do native phone verification (no reCAPTCHA/APNs/SafetyNet flow). Completing it requires a **development build** with `@react-native-firebase/app` + `@react-native-firebase/auth`, the Expo config plugins, `google-services.json` / `GoogleService-Info.plist`, the SHA-1/SHA-256 fingerprints registered in Firebase, and (iOS) APNs setup. That replaces only the native branch of `FirebaseAuthService.signInWithPhone`; the interface, routing and gates stay as they are. On native today the sign-in screen states this and offers no workaround.
- The Firebase project used by the app must be the same one the backend's `FIREBASE_PROJECT_ID` verifies tokens for (the Customer App's project).

## Security boundaries

- Only client-safe Firebase config in the bundle; no Admin key, service account or backend secret. No direct Firestore access from mobile (no Firestore SDK is used).
- Provisioning of merchants/drivers stays server-side; the app has no registration, role selection, shop or driver creation.
- `.env*.local` is gitignored; only `.env.example` (placeholders) is tracked.

## Related fix

Confirmations/error alerts in the Driver (reject, deliver), Merchant inventory (disable) and products screens now use `lib/alerts.ts` (`Alert.alert` on native, `window.confirm`/`alert` on web) — react-native-web's `Alert.alert` is a no-op, so these were previously unusable on web.
