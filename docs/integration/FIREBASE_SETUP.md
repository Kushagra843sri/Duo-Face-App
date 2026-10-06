# Firebase setup (one project for server + Customer App + Merchant/Driver app)

Everything below is free on Firebase's Spark plan except real phone-OTP SMS (not used by the Customer App, which signs in with email + password). Do these once; nothing real can run before step 1–5.

## 1. Create the project
Firebase console → Add project (any name, e.g. `allz-bharat`). Disable Google Analytics (not needed). Spark plan is fine.

## 2. Authentication
Authentication → Get started → Sign-in method → enable **Email/Password** (Customer App). Merchant/Driver app web sign-in uses **Phone**: enable it too and add test numbers for development (Authentication → Sign-in method → Phone → Phone numbers for testing).
Authentication → Settings → Authorized domains: add the domain the web build is served from (and `localhost` for development).

## 3. Firestore
Firestore Database → Create database → **Production mode**, pick the region closest to your users (e.g. `asia-south1`, Mumbai; it cannot be changed later).
Rules (Firestore → Rules). Only the server (Admin SDK, which bypasses rules) touches data, so deny everything from clients:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} { allow read, write: if false; }
  }
}
```

This also covers `orders`, `duo_face_inventory`, `order_events`, `duo_face_delivery_codes`: no client may write them.

## 4. Web app config (client apps)
Project settings → Your apps → add a **Web app**. Copy its config values into `customer/.env.local` and `app/.env.local`:
`EXPO_PUBLIC_FIREBASE_API_KEY`, `..._AUTH_DOMAIN`, `..._PROJECT_ID`, `..._APP_ID` (client-safe identifiers, not secrets).

## 5. Service account (server only)
Project settings → Service accounts → Generate new private key. Put `project_id`, `client_email`, `private_key` into `server/.env` as `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (see `server/.env.example`). **Never commit it, never put it in a mobile app, never paste it in chat.**

## 6. Push notifications (Android)
Project settings → Your apps → add an **Android app** with package `com.duoface.customer`; download `google-services.json` and set `GOOGLE_SERVICES_JSON=<path>` for the build. The server sends through FCM with the same service account (no extra key). Push needs a development/production build, not Expo Go. iOS push needs an Apple developer account and APNs key and is not set up yet.

## 7. Other server settings
`PROFILE_ENCRYPTION_KEY` (32 random bytes, base64: the command is in `server/.env.example`) is required for profiles and for showing the delivery code in the Customer App. Redis (`REDIS_URL`, e.g. Upstash free tier) for live driver location. Exotel, OpenCage, Cloudflare R2: only for calls/SMS, geocoding, and KYC photos.

## 8. First data
Nothing needs to be created by hand. A shop owner registers in the Merchant/Driver app (which creates the shop and lists it for customers, **closed**), fills in the profile, adds products with their starting stock, and taps **Open** on the dashboard. Customers then see the shop in the Customer App. Drivers register the same way and go on duty. Keep one admin account (section 9) for refunds and KYC review.

## 9. Admins (refunds)
Admins are not stored anywhere: they are an allowlist on the server. In Firebase console -> Authentication -> Users, copy the **User UID** of each person who should be an admin, and set `ADMIN_FIREBASE_UIDS=uid1,uid2` in `server/.env` (restart the server). They sign in with the normal app (Merchant/Driver app, same sign-in screen) and are taken to the admin area automatically. Use accounts that are not also a shop owner or driver: an admin UID is only ever an admin. To remove an admin, delete the UID from the list and restart.
