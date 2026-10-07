# Standalone apps (APK) — step by step

Two apps, two APKs: **Duo-Face Partner** (`app/`, shops + delivery partners, `com.duoface.partner`) and **Allz Bharat** (`customer/`, customers, `com.allzbharat.app`). Cash on delivery works from day one; online payment turns on after Cashfree approves the account (section 9).

Do the sections in order. Everything marked **You** needs your accounts; the code side is already prepared (`render.yaml`, `eas.json`, app configs).

## 1. Put the code on GitHub (You)
The repo is `Kushagra843sri/Duo-Face`. Render and EAS both build from it. Commit and push the current work first (never commit `.env`, `.env.local` or `google-services.json`; they are gitignored).

## 2. Redis for live driver location (You, free)
1. upstash.com → sign up → Create database (Redis), region closest to Render's (Singapore).
2. Copy the **`rediss://...`** connection URL. This is `REDIS_URL`.

## 3. Host the server on Render (You)
1. render.com → New → **Blueprint** → connect the GitHub repo. It reads `render.yaml` and creates the `duoface-server` web service.
2. Fill the prompted values (copy from your local `server/.env`; same names): `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (paste the whole key including the `-----BEGIN/END-----` lines; Render accepts real new lines), `PROFILE_ENCRYPTION_KEY`, `DELIVERY_OTP_SECRET`, `ADMIN_FIREBASE_UIDS`, `OPENCAGE_API_KEY`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`, `REDIS_URL`.
3. After the first deploy, copy the service address (e.g. `https://duoface-server.onrender.com`) into `PUBLIC_BASE_URL` and redeploy.
4. Check: open `https://<your-service>.onrender.com/health` → `{"status":"ok"}`.
5. Free plan sleeps after ~15 min idle (first request takes ~30–60 s) and real-time sockets drop when it sleeps. For real customers use the paid Starter plan (change `plan: free` in `render.yaml`).

## 4. Firebase (You)
Console → project **allzbharat**:
1. Project settings → Your apps → **Add app → Android** twice: package `com.duoface.partner` and package `com.allzbharat.app`. Download each `google-services.json`. Keep them outside git (e.g. `D:\secrets\partner\google-services.json`, `D:\secrets\customer\google-services.json`).
2. Authentication → Sign-in method: **Email/Password** enabled (it is).
3. After the first build (section 7) add the build's **SHA-1** under each Android app (only needed for Google-signed features; email sign-in and push work without it).

## 5. Google Maps key (You)
Google Cloud console (project linked to Firebase) → APIs & Services → enable **Maps SDK for Android** → Credentials → Create API key. Restrict it to Android apps: the two package names above (add SHA-1s after the first build). This is `GOOGLE_MAPS_ANDROID_API_KEY`.

## 6. Expo / EAS (You)
```
npm i -g eas-cli
eas login
cd app && eas init          # creates the project, writes extra.eas.projectId into app.json
cd ../customer && eas init
```
Commit the `app.json` changes `eas init` makes.

Then add the build-time variables **per app project** (expo.dev → project → Environment variables → environment **preview**, or with the CLI `eas env:set --name X --value Y --environment preview --visibility plaintext`). `.env.local` is NOT uploaded by EAS, so every value must be added:

| Variable | Value | Visibility | Apps |
|---|---|---|---|
| `EXPO_PUBLIC_API_URL` | `https://<your-service>.onrender.com` (no trailing slash) | plaintext | both |
| `EXPO_PUBLIC_FIREBASE_API_KEY` / `_AUTH_DOMAIN` / `_PROJECT_ID` / `_APP_ID` | same as in `app/.env.local` | plaintext | both |
| `GOOGLE_MAPS_ANDROID_API_KEY` | the Maps key | secret | both |
| `GOOGLE_SERVICES_JSON` | upload that app's own `google-services.json` | secret, **file** type (dashboard) | both (different file each) |

## 7. Build the APKs
```
cd app && eas build -p android --profile preview
cd ../customer && eas build -p android --profile preview
```
Each build takes ~15–25 min and ends with a download link / QR code. Open it on the phone to install (allow "install unknown apps"). `preview` makes an installable `.apk`; `production` makes an `.aab` for the Play Store later.

## 8. Test with real phones
Use `FIRST_E2E_RUN.md`. Minimum path with a cash order: shop registers (email + password) and adds a product, taps **Open** → customer signs up, books → shop gets "New order" → accepts, **Request driver** → driver (on duty) gets the offer, accepts, picks up → customer sees the delivery code on the order screen → driver enters it → delivered. Pushes arrive on the lock screen only in these installed builds (not Expo Go).

## 9. After Cashfree approves the account (not now)
Render → add `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, `CASHFREE_ENV=production`; make sure `PUBLIC_BASE_URL` is the https Render address (webhook `<PUBLIC_BASE_URL>/webhooks/cashfree`); redeploy. The customer app then shows "Pay online" by itself (it asks the server).

## Not covered
iOS builds (needs an Apple developer account), Play Store listing, the admin panel, native phone OTP.
