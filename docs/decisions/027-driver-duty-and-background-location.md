# 027 — Driver on/off duty and background location

## Decision
A driver activates themself with one button ("Go on duty") and deactivates with the same button ("Go off duty").

- **On duty**: the app sends the driver's location **every minute**, including with the app minimised or the screen locked. Each send goes to the existing `POST /driver/location`, which **replaces** the single last-known-location document (`duo_face_driver_locations/{driverId}`) — no history is kept.
- **Off duty**: the app stops sending. Nothing is deleted; the last known location simply stops being refreshed.
- **Dispatch** (026) only offers orders to **on-duty** drivers. An on-duty driver's location counts as recent for **10 minutes** (`DUTY_LOCATION_STALE_AFTER_MS`); off-duty drivers are never candidates, however close.

## Server
- `duo_face_drivers/{driverId}`: additive optional `onDuty` (absent = off) and `dutyChangedAt`.
- `GET /driver/duty` → `{ onDuty, dutyChangedAt }`; `PUT /driver/duty` body `{ onDuty: boolean }` (`.strict()`; the driver is always the authenticated one, a client-sent `driverId` is a 400). Same guard chain as the other driver routes.
- `PUT {onDuty:false}` while the driver has an assignment in `assigned | accepted | picked_up` → `409 Finish or reject your current delivery first.` Going off duty also drops any live Redis position (best effort).
- `DriverService.setDuty` changes only `onDuty` / `dutyChangedAt` / `updatedAt`; `DriverDutyService` holds the rule above.

## App
- `lib/dutyTask.ts` registers the background task with `TaskManager.defineTask` in the **global scope** (imported from `app/_layout.tsx`), as the Expo docs require because the OS may start the JS app headless. Each batch → newest fix → `shouldSendDutyFix` (≥55 s since the last send, accuracy ≤ 300 m) → `updateDriverLocation`. A 401/403 stops the task.
- `lib/dutyController.ts`: `goOnDuty` = foreground permission → background permission ("Allow all the time") → `PUT duty true` → `startLocationUpdatesAsync` (Balanced, `timeInterval` 60 s, Android foreground-service notification, iOS background indicator) → one immediate fix; if sending can't start the server flag is rolled back. `goOffDuty` calls the server **first** so a 409 leaves tracking running, then stops the task. `refresh()` re-aligns device and server on launch/focus (`decideReconcile` in `lib/dutyPolicy.ts`): server on but task dead (reboot / force-quit) → restart if permitted, else "Paused — Resume".
- `components/DutyCard.tsx` on the driver dashboard: status badge, last location sent, errors, "Open settings" when the background permission is missing.
- `lib/authService.getIdToken` now awaits `authStateReady()` so the headless background start doesn't mistake "session not restored yet" for "signed out".
- `app.json`: `expo-location` background flags enabled (Android background + foreground service, iOS background location) and an "always" permission string. `expo-task-manager` added.

## Requirements and limits
- **Needs a development or release build.** Expo Go on Android cannot run TaskManager and iOS Expo Go has no background execution. The card says so in Expo Go / web; everything else in the app still runs in Expo Go. Build with `npx expo run:android` (needs Android Studio) or EAS (`eas build --profile development`).
- Android shows a **persistent "you are on duty" notification** (OS requirement). Android 10+ needs the separate "Allow all the time" permission; Google Play requires a background-location declaration before release.
- **iOS ignores `timeInterval`**: it reports as the phone moves, so a stationary iPhone may not send every minute. The 10-minute dispatch window absorbs this; it is not a guarantee.
- Some Android vendors kill background services under battery saver; drivers may need to exempt the app.
- Force-quitting the app stops updates until it is reopened; the driver then ages out of dispatch after 10 minutes.
- Per-delivery live tracking (022, foreground) and the manual "Update location" button are unchanged.

## Not verified by automated tests — manual device checklist
Server rules are covered by unit/route tests; the background behaviour needs a phone:
1. Install a development build; sign in as a driver; Dashboard → **Go on duty**; grant "Allow all the time". Notification appears; status shows ON DUTY.
2. Lock the phone for ~5 minutes. In Firestore, `duo_face_driver_locations/<driverId>.capturedAt` should advance roughly once a minute (Android).
3. Reopen the app: "Last location sent" is a minute or two old.
4. Accept a delivery, tap **Go off duty** → blocked with the 409 message and sending continues. Finish/reject it, then **Go off duty** → notification disappears and `capturedAt` stops advancing.
5. Go on duty, force-quit, reopen: status resumes (or shows Paused/Resume).
6. As a merchant, request a driver while the test driver is off duty (not offered) and on duty (offered).
