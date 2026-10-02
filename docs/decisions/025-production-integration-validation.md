# 025 — Production integration validation (Phase 24A)

Status: **partially executed. The real-infrastructure checks were NOT run: this environment has no Firebase credentials, no Firebase project and no live Customer App backend.** This record separates what was actually verified from what is only source-level evidence or still blocked.

## Verification status

| Check | Status |
|---|---|
| Firebase Admin connects to the real project | **NOT VERIFIED** |
| Real Firebase ID token verified by `authenticateFirebase` | **REAL AUTH NOT VERIFIED** |
| Real Customer App Firestore read (order) | **NOT VERIFIED** |
| Real `out_for_delivery → delivered` write | **REAL SYNC WRITE NOT VERIFIED — no legitimate out_for_delivery test order available** |
| Real Firestore transaction behavior | **NOT VERIFIED** (only a mocked Firestore was used) |
| Real FCM / Redis / OpenCage / maps | out of scope for 24A, not verified |
| Server reachable on the LAN interface | **VERIFIED** (locally: loopback and the machine's own LAN address) |

### Why it stopped

In the environment used for this phase, none of `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, or any `EXPO_PUBLIC_FIREBASE_*` value was set; there is no `.env`, no service-account file, and no `google-services.json`. Nothing was faked. More fundamentally, the project documentation (decisions 002/011) records that Allz Bharat is an **archived, undeployed handover with zero access: no Firebase project exists** ("0 live Cloud Functions, 0 live secrets"). So there is currently *no real Customer App Firestore* to read from or write to until a Firebase project is created and the Customer App backend deployed.

### What is needed to run the real checks (blockers for 24B)

1. A Firebase project (the Customer App's, once it exists) with: Authentication → Phone enabled (+ a test phone number for development), Firestore created, Allz Bharat `firestore.rules` deployed.
2. A service account for it → server `.env`: `FIREBASE_PROJECT_ID` + `FIREBASE_CLIENT_EMAIL` + `FIREBASE_PRIVATE_KEY` (or `GOOGLE_APPLICATION_CREDENTIALS` pointing at a local file outside the repo). Never committed.
3. The web-app config values → `app/.env.local` (`EXPO_PUBLIC_FIREBASE_*`) from the *same* project.
4. Seeded controlled test data: a user, a shop, a product; an order created through the Customer App's own flow (`createPaymentOrder` → `verifyPayment`/webhook) so it is a legitimate `pending` order; a Duo-Face merchant/driver identity and shop mapping.
5. An authoritative way for the test order to reach `out_for_delivery` (see below). Directly editing Firestore into that state is **not** an acceptable substitute for the write test.

## Actual Customer App order lifecycle (source-verified, not live-verified)

Read from the handover source (`source_code/functions/src`, `customer_app/firestore.rules`) — the same source decisions 002/011 were built on:

- `functions/src/index.ts` exports exactly three functions: `createPaymentOrder` (callable), `verifyPayment` (callable), `cashfreeWebhook` (HTTPS). `firebase.json` deploys only `functions/` and `customer_app/firestore.rules`.
- An order is created **only** by `OrderPromotionService.promoteIntentToOrder` (called from `verifyPayment` / the webhook) at `status: "pending"`.
- The only client-side change the rules allow is the customer's `pending → cancelled` (only `status`, `cancelledAt`, `cancellationReason`).
- Repo-wide, `confirmed`, `preparing`, `ready_for_pickup`, `out_for_delivery`, `delivered`, `rejected` are **never written by any code**. **No component owns `pending → confirmed → … → out_for_delivery` today.**

**Integration blocker:** the Customer App never reaches `out_for_delivery`. With today's system `CustomerOrderSyncService` will always find `pending` and report `protected_status` (this is by design and is safe). Deciding *who* owns the intermediate statuses (merchant confirmation? Duo-Face on `picked_up`?) is a product/ownership decision that this phase deliberately does not make; `picked_up → out_for_delivery` was **not** added.

## Cloud Functions / external reactions

Source-level finding: the Customer App backend contains **no Firestore triggers** (`onDocumentWritten/Updated/Created`), no scheduled or Pub/Sub functions, and no code that references `delivered` or `out_for_delivery` — so no reaction to `orders/{id}.status = delivered` exists in the reviewed source: no conflict, no loop, no secondary status mutation. Caveats: this is the archived source, not a deployed project (there is nothing deployed to inspect); anything added when a project is stood up must be re-reviewed; payment reconciliation/settlement logic that someone adds later could key off status.

## Firebase Admin security boundary

`firebase-admin` uses service-account credentials, which **bypass Firestore security rules**. The Customer App's rules (customer can only read own orders, cancel only while pending) therefore do not protect anything from Duo-Face's server; Duo-Face must and does enforce its own authorization: verified Firebase ID tokens, ownership checks (order `customerId`, assignment driver/shop), and the sync guard. `CustomerOrderSyncService` remains the only application service allowed to write a Customer App order, through the single provider operation `markOrderDelivered(orderId, expectedShopId)`, which sets only `status`, only from `out_for_delivery`, inside a Firestore transaction. There is no `updateOrderStatus`, and rules were not (and must not be) loosened to make testing easier. The server's service account should be a dedicated least-privilege identity, and its key must never reach the mobile app.

## Mobile backend URL (local development on a physical phone)

Before this phase: `app/lib/env.ts` read `EXPO_PUBLIC_API_URL` and otherwise fell back to `http://localhost:4000` (with a console warning) — which on a physical phone is the phone itself. Server port: `PORT` from `server/.env` (required by `loadEnv`; `.env.example` uses 4000). `server.ts` listens on all interfaces (`::`).

Change: when `EXPO_PUBLIC_API_URL` is unset **in development only** (`__DEV__`), the app derives the host from Expo's own dev-server address (`Constants.expoConfig.hostUri`) and uses `EXPO_PUBLIC_API_PORT` (default 4000). An explicit `EXPO_PUBLIC_API_URL` always wins; production builds never derive a host and must set it. No IP is committed; `.env.example` now shows the variable commented out (a leftover active `localhost` line would have overridden the derivation). Verified: the built server answers `/health` on the machine's LAN address. **Not verified from an actual phone.**

Caveats for the phone: Phone OTP is not implemented on native (decision 017), so in Expo Go the sign-in screen will say phone sign-in is unavailable — authenticated screens cannot be reached from the native app until native Firebase phone auth is set up; the web build opened in the phone's browser does support Phone OTP but then needs an explicit `EXPO_PUBLIC_API_URL` and `CORS_ORIGIN` set to the web origin. Windows reported the active network as **Public**; an inbound "Node.js" allow rule exists for the Public profile, but if the phone cannot connect, check the firewall profile and router client isolation. Android development builds (not Expo Go) block cleartext HTTP by default and would need cleartext enabled for dev.

## Remaining blockers for Phase 24B

Real Firebase project + credentials + test user/phone; deployed Customer App backend and rules; seeded controlled test data; an owner and mechanism for `out_for_delivery`; native Phone OTP for the phone app; then re-run the real checks in the table above and update this document.
