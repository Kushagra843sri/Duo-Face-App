# Customer App — environment setup runbook (for Duo-Face integration)

Source: the Allz Bharat handover package — `README.md`, `Allz_Bharat_Developer_Handover_Guide_FRESH_SETUP.pdf` (7 pp.), `setup/02_NEW_FIREBASE_PROJECT_SETUP.md` (in the copy we received this file actually contains the Windows prerequisites list) and `.firebaserc.example`. The `source_code/` tree itself was **not** in this batch; the data-model facts live in [CUSTOMER_APP_REQUIREMENTS.md](CUSTOMER_APP_REQUIREMENTS.md), which was derived from that source. This runbook only adds what is needed to **stand up an environment Duo-Face can integrate with**.

## 0. Ground rules from the handover
- **Strict zero-access**: nothing from the previous developer's Firebase/GitHub/Cashfree exists for us. We create and own everything.
- **Never commit** private keys, service-account JSON, `.env` files, Cashfree secrets. Cloud-Function secrets live in Firebase Secret Manager; Duo-Face server secrets live in `server/.env` (gitignored).
- Payment code (Cashfree) is **implemented but never run** against any real/sandbox gateway; Cloud Functions have **never been deployed**. Treat both as unverified.

## 1. Tooling (Windows)
Git; Flutter ≥ 3.13; Android Studio (SDK cmdline-tools, build-tools, emulator; `flutter doctor --android-licenses`); Node 18 or 20 LTS; `npm i -g firebase-tools`; `dart pub global activate flutterfire_cli`. Duo-Face's own app/server need only Node + Expo.

## 2. One Firebase project, shared by both apps
Duo-Face reads/writes the **same Firestore** as the Customer App (decision 002), so there is exactly one project.

1. Firebase Console → create the project (owner = the client's Google account; see open question below).
2. **Authentication → Phone**: enable; add test numbers (the guide's example is `+91 9876543210` / code `123456`). Duo-Face's mobile sign-in (decision 017) uses the same Phone Auth, so the same test numbers work for merchant/driver testing.
3. **Firestore → Production mode**, pick a region once (guide suggests `asia-south1`; it cannot be changed later). India-based users → `asia-south1` is the sensible choice.
4. Associate the CLI: copy `.firebaserc.example` → `.firebaserc` and replace `<YOUR_NEW_FIREBASE_PROJECT_ID>` (`firebase use <id>`).
5. `firebase deploy --only firestore:rules` — deploys the Customer App rules (`customer_app/firestore.rules`).
6. Seed dev data: `cd tools/seed_commerce && npm install`, set `GOOGLE_APPLICATION_CREDENTIALS` to a service-account key, `node seed.js --confirm` → **16 documents: 4 categories, 2 shops, 10 products**.
7. Customer app only: `flutterfire configure --project=<id>` (android + web) generates `firebase_options.dart` / `google-services.json`. Not needed by Duo-Face.

### What this means for Duo-Face
| Topic | Consequence |
|---|---|
| Firestore rules | Rules protect **client** access only. Duo-Face's server uses the Admin SDK, which bypasses rules, and the Duo-Face mobile app never touches Firestore. So the Duo-Face collections (`duo_face_*`) need **no** rule changes — and the deployed rules (which only name the Customer App's collections) leave them closed to every client. Do not loosen them. |
| Composite index | The Customer App needs `orders(customerId, createdAt)` (handover §3). Duo-Face queries are single-field equality with sorting in application code, so **no new composite index** is required — keep it that way (see the comments in `FirestoreCustomerAppOrderProvider` / `FirestoreDeliveryAssignmentStore`). |
| Phone Auth | One identity pool. A Duo-Face merchant/driver is a Firebase user whose role is resolved server-side from Duo-Face collections (decisions 005/006), never from a token claim. |
| Seed data | The 2 seeded shops are the only way to test the merchant flow: provision a Duo-Face merchant with `customerAppShopId` = a seeded shop id (decision 009). Seed shops have a text `address` only → pickup geocoding (§4) is what gives them coordinates. |
| Orders | There is no way to create an order from the Customer App without the Cloud Functions deployed (rules block client creation). To test deliveries before payments work, insert an `orders/{id}` document with the Admin SDK in the shape documented in the requirements doc §7 (status `pending`, `paymentStatus` `paid`). |

## 3. Duo-Face server wiring (`server/.env`)
| Variable | Value / where it comes from |
|---|---|
| `FIREBASE_PROJECT_ID` | the project id from §2 |
| `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` **or** `GOOGLE_APPLICATION_CREDENTIALS` | a service-account key: Firebase Console → Project settings → Service accounts → Generate new private key. Prefer a **dedicated** service account for Duo-Face with Firestore + FCM roles only (open question below). Never commit it. |
| `OPENCAGE_API_KEY` | geocoding (§4) — already set in `server/.env` |
| `REDIS_URL` | live driver locations (decision 022); without it live tracking answers 503 and dispatch falls back to the last manual location |

The mobile app needs only the public Firebase **web** config (`app/.env.example`) — never admin credentials.

## 4. Geocoding (OpenCage) — in use by dispatch
Used for (a) the customer's delivery address (map pin, decision 021) and (b) the **shop pickup point** for nearest-driver dispatch (decision 026). Results are cached in `duo_face_delivery_destinations`, so each distinct address costs one lookup.
- Key stored in `server/.env` (`OPENCAGE_API_KEY`), verified working against `api.opencagedata.com` (HTTP 200, plan limit **2,500 requests/day**; remaining quota reported in the response).
- **To verify with OpenCage before launch**: their terms for storing/caching results on the free plan versus a paid plan. We cache indefinitely; confirm that is permitted for the plan the client buys.
- Shop pickup accuracy: the Duo-Face shop stores its own `pickupLocation` (decision 026). Provisioning stores an explicit one or geocodes the Customer App address once; `backfillPickupLocation(shopId)` fixes shops provisioned earlier and `setPickupLocation` corrects a wrong one. Only shops without a stored location fall back to geocoding the free-text address on each request.

## 4b. Telephony (Exotel) — masked calls and the delivery-code SMS
See decision 028. Needs: an Exotel account (API key/token/SID), a purchased **ExoPhone** (`EXOTEL_CALLER_ID`), a public HTTPS URL for `PUBLIC_BASE_URL` (status callbacks go to `/webhooks/exotel/call-status`), and for the SMS a **DLT** registration (sender, entity id, approved template whose text goes in `EXOTEL_SMS_TEMPLATE` with `{code}`). Generate `CALL_WEBHOOK_SECRET` and `DELIVERY_OTP_SECRET` yourself (16+ random characters each). Set `GEOCODER_MIN_CONFIDENCE=9` or `10` so the 50 m delivery rule is meaningful.

## 4c. Profiles: encryption key and R2 photo bucket
See decision 029. Generate `PROFILE_ENCRYPTION_KEY` (32 random bytes, base64) and back it up. Create a **private** Cloudflare R2 bucket and an API token with read/write on it, then set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. Never make the bucket public (photos are served only through short-lived signed URLs). Set `PLATFORM_COMMISSION_BPS` (1000 = 10%).

## 5. Cloud Functions & payments (for completeness)
`cd functions && npm install && npm test` (16 tests) → `firebase functions:secrets:set CASHFREE_SECRET_KEY`, `CASHFREE_APP_ID` (the requirements doc also lists `CASHFREE_ENV`) → `firebase deploy --only functions`. Functions exported: `createPaymentOrder`, `verifyPayment` (callables) and `cashfreeWebhook` (HTTPS). Needs the client's own Cashfree account. Duo-Face does not call these; it only reads the resulting `orders`.

## 6. Verification matrix (what has/hasn't been proven)
| Item | State |
|---|---|
| Customer App tests (122) + `flutter analyze` | claimed by handover; **not re-run by us** |
| Functions tests (16) | claimed; **not re-run** |
| Duo-Face server tests | 601 passing locally (fakes for Firestore/Redis/geocoder) |
| OpenCage key | **verified live** (this session) |
| Firebase project, Phone Auth, Firestore, service account, Redis | **not created / not exercised** — nothing here has run against real infrastructure |
| Cashfree payments, deployed Functions | **never run** by anyone |

## 7. Still not available / open
1. All setup docs named in the handover README have now been received; nothing further is expected from them.
2. Who owns the Firebase project and billing (client vs. us), and whether Duo-Face gets its own scoped service account — still the open decision from requirements §18.
3. Firestore region choice (`asia-south1` recommended; irreversible).
4. Staging vs production: the guide describes one dev project. We should decide whether to create a separate production project before launch.
