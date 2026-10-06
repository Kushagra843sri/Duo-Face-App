# 031 — Customer App (built from scratch)

## Status

Accepted 2026-10-06 (project owner). Supersedes the assumption in 002 that the Customer App ("Allz Bharat") would be integrated as an existing app. Confirmed by the owner: **nothing is deployed and the client has no usable Customer App; we build it from scratch.** The Allz Bharat handover remains a reference for the Firestore schema (`CUSTOMER_APP_REQUIREMENTS.md`) only.

## Decisions

1. **Separate Expo app** in a new `customer/` folder, next to `app/` (merchant + driver) and `server/`. Not merged into the existing app: customers are open sign-ups with no role, store review would object to driver background-location/camera permissions in a customer app, and releases should be independent.
2. **No new backend.** The same Express server serves the Customer App under `server/src/routes/customer/` (tracking and notifications already live there). **No Firebase Cloud Functions** (they need the paid Blaze plan; the server does the same job).
3. **Auth:** Firebase phone OTP. The server verifies the Firebase ID token. Customers have no role; ownership is `order.customerId === verified uid` (as in 023). The app never sends a role.
4. **Payments: Cashfree** for all online payments (owner decision; supersedes Razorpay in CLAUDE.md and the SPEC ambiguity noted in 002). Launch order: **Cash on Delivery first**, then Cashfree online payment. Cashfree sandbox is free for development; live keys need the client's business KYC. Secrets in `.env` only; `.env.example` updated when added.
5. **Shared data:** reuse `users`, `users/{uid}/addresses`, `shops`, `products`, `categories`, `orders`, `payment_intents`. Only add fields or new collections; never alter existing fields (CLAUDE.md rules).

## Architecture

```
Customer App (Expo)        Merchant/Driver App (Expo, exists)
        \                           /
         REST + Socket.io -> Duo-Face server (Express + TS)
                                |
              Firestore (Admin SDK)  +  Redis (live driver GPS)
```

### Order creation (server-only)

`POST /customer/orders`:

1. Verify Firebase token; validate body with zod (items as `productId` + `quantity`, `addressId`, `paymentMethod`). Prices are never taken from the client.
2. Recalculate prices from Firestore. Existing Customer App money is float rupees: convert explicitly to integer paise at the boundary; all Duo-Face arithmetic in paise.
3. Atomically decrement stock in a Firestore transaction (decision 003: new Duo-Face-owned inventory quantity model, not a `stock` field on `products`). Two buyers for the last unit: exactly one succeeds.
4. Create the order `pending` through `services/orderState`, write `order_events`, emit `order.created`. The existing merchant → dispatch → driver → delivery-code flow (007–028) takes over unchanged.
5. COD: order goes straight to the merchant. Online (later): create Cashfree order, promote to a real order only after verified payment (webhook with signature check + client verify).

Customer cancellation only while `pending`, through the API (not a direct Firestore write).

### Customer endpoints (MVP)

| Endpoint | Purpose |
|---|---|
| `GET /customer/shops` | Shops nearby / active, open status |
| `GET /customer/shops/:id/products` | Products (in stock, active) |
| `GET/POST/PATCH/DELETE /customer/addresses` | Address book |
| `POST /customer/orders` | Place order (above) |
| `GET /customer/orders`, `GET /customer/orders/:id` | History and detail (own orders only) |
| `POST /customer/orders/:id/cancel` | Cancel while `pending` |
| `GET /customer/orders/:id/tracking` | Exists (023) |
| Socket.io `subscribe {orderId}` | Exists (023) |
| `POST /customer/devices` | Register FCM token (024) |

### Customer screens (MVP, ~8)

Login (phone OTP) · Shops nearby · Shop products · Cart · Checkout (address + payment) · Order status with live map and delivery code · Order history · Profile and addresses.

Cart lives on the device only; the server prices it at checkout.

### Out of scope for now

Coupons, ratings/reviews, search filters, wallet, Places autocomplete (GPS pin + typed address), admin panel, web version.

## Free-tier choices

Firestore Spark (50k reads / 20k writes per day), FCM, Cloudflare R2, Upstash Redis free tier, Google Maps free monthly caps (OpenStreetMap as fallback). Server hosting: free tiers that sleep break sockets, so a pilot should use an always-on free VM or a cheap VPS. Firebase phone OTP is free for test numbers only; check current real-SMS quota before launch. Cashfree has per-transaction fees only, no free live tier.

## Milestones

- **C1** Server: customer catalog/address/order routes, checkout with stock transaction, COD, tests (including last-unit race and ownership).
- **C2** `customer/` app skeleton: login, shops, products, cart, checkout against C1.
- **C3** Order tracking, history, push notifications, address management.
- **C4** Cashfree online payment, then a real-device pass.

## Not verified / open

- Real Firebase project and service account (see `CUSTOMER_APP_SETUP_RUNBOOK.md`) are still needed before anything runs against real infrastructure.
- Delivery fee and platform fee rules for new orders are undefined; C1 needs the owner's numbers (flat fee vs distance-based).
- Inventory quantity model fields are designed in C1 (extends 003).

## C1 / C1b implementation notes (2026-10-06)

- **Done (server):** customer catalog, addresses, checkout (COD), cancel; `services/orderState.ts` (allowed-transition map + `order_events`); `services/orderStatusService.ts` (transactional status writes shared by merchant and delivery events, stock restored on cancel/reject).
- **Merchant status route:** `PATCH /merchant/orders/:orderId/status` with `confirmed | rejected | preparing | ready_for_pickup`. Cross-shop orders return 404.
- **Driver pickup:** `DeliveryLifecycleEffectsService.onPickedUp` walks the order forward to `out_for_delivery` (one `order_events` row per step, actor = driver), which the existing delivered-sync requires. Dispatch is not gated on order status, so a pickup can precede the merchant's updates; the walk keeps the transition map intact. A failure here is logged and never blocks the driver or the notification.
- **Money:** existing order fields stay rupees (merchant side reads them); exact integer `pricingPaise` / `pricePaise` fields are written beside them. Fees are zero via `computeFees` (single seam, owner decision).
- **Products are sellable only with an active `duo_face_inventory` record** (quantity − reserved > 0).
- **Not verified:** nothing has run against real Firestore (only in-memory fakes with serialized transactions); real transaction contention, indexes and Firestore security rules are untested. Rules must deny client writes to `orders`, `duo_face_inventory`, `order_events`.

## C2 implementation notes (2026-10-06)

- **`customer/`** Expo app (Expo Router, NativeWind, same design system as `app/` with an orange accent). Screens: sign-in, shops, shop products, cart, checkout (address + cash on delivery), order status (progress, cancel while pending, 15 s polling), order history, profile, saved addresses, address form (typed or GPS-assisted).
- **Sign-in is email + password**, not phone OTP: the Firebase JS SDK cannot do phone verification on iOS/Android (see decision 017), email/password works on every platform today, is free and needs no dev build. The server only needs a verified Firebase uid, so switching to phone later changes only `customer/lib/authService.ts` and the sign-in screen. **This departs from the phone-OTP sign-in assumed earlier; revisit with the owner.**
- Cart is device-local (AsyncStorage), one shop at a time, re-priced by the server at checkout. Each checkout attempt carries a `clientRequestId`, so a retry after a network drop returns the same order.
- Money is integer paise end to end; `lib/money.ts` is the only formatter.
- **Verified:** typecheck, lint, web bundle export, and a click-through in the browser in dev preview mode (sample data): shops → products → add/steppers → cart persisted across a reload → checkout → place order → order screen → cancel → orders list → addresses (+ validation) → sign out redirects to sign-in. **Not verified:** real Firebase sign-in, talking to the real server, iOS/Android devices, GPS address fill, dark mode visuals (screenshots were unavailable).
- Done in C3 (tracking, code, push) and C4 (Cashfree).

## C3 implementation notes (2026-10-06)

- **Live tracking:** the order screen polls `GET /customer/orders/:id/tracking` every 15 s (no socket yet) and shows the driver and the customer's address on a map (react-native-maps; web shows coordinates as text). A stale position is labelled "may be out of date".
- **Delivery code in the app (amends decision 028):** 028 stored only an HMAC of the code and sent it by SMS. SMS needs Exotel + DLT registration (paid), so the server now also keeps the plaintext **encrypted at rest** (AES-256-GCM via `FieldCrypto`, key `PROFILE_ENCRYPTION_KEY`, context-bound to the order) in `duo_face_delivery_codes/{orderId}`. `GET /customer/orders/:id/delivery-code` returns it only to the order's owner and only while the order is `out_for_delivery`. Verification still uses the HMAC. Without the key the endpoint answers 503 and nothing is stored. A customer who can read the code could also tell it to someone else, exactly as with SMS.
- **Push notifications:** `customer/lib/push.ts` registers the Android FCM token with the existing `/customer/notifications/device` endpoint after sign-in and unregisters on sign-out. Needs a development/production build with `google-services.json`; does nothing on web, Expo Go, preview or iOS. iOS push (APNs) is not set up.
- **Verified:** server tests (809 pass), typecheck, lint, web export; browser click-through in preview mode of a full order lifecycle (status advancing, driver position moving, code appearing only when on the way). **Not verified:** the native map, a real push, any of it against a real Firebase project / driver.
- Setup steps for the client: `docs/integration/FIREBASE_SETUP.md`.

## C4 implementation notes (2026-10-06): Cashfree online payment

Verified against Cashfree's current docs (API version `2026-01-01`): create order `POST /pg/orders` (amount in decimal rupees, `order_id` 3-45 chars, `customer_phone` required), fetch `GET /pg/orders/{id}` (`order_status` PAID/ACTIVE/EXPIRED/TERMINATED), webhook signature = base64(HMAC-SHA256(`x-webhook-timestamp` + raw body, secret key)) in `x-webhook-signature`. Sandbox is free; live needs the client's activated business account.

**Flow.** `POST /customer/orders` with `paymentMethod: "online"` creates the order like COD (stock reserved in the same transaction) but `paymentStatus: awaiting_payment`, with a 15-minute hold (`paymentExpiresAt`). The shop does not see it (merchant list/get hide it) and cannot change its status until it is paid. `POST /customer/orders/:id/payment` creates (or re-fetches) the Cashfree order and returns a checkout URL on this server (`/pay/checkout?session=...`): a tiny page that loads Cashfree's JS SDK and redirects to their hosted checkout. The app opens it in the in-app browser, so it works identically in Expo Go, native builds and on web with no native Cashfree SDK.

**Trust rule.** An order becomes `paid` only after this server asks Cashfree and is told `PAID` for the exact amount (integer paise). The webhook, the customer's "verify" call and the expiry sweep all go through that same check; a signed webhook body alone changes nothing. Paths are idempotent. A wrong amount is recorded (`amount_mismatch`) and the order stays unpaid.

**Expiry.** A 60 s sweep (server start) settles unpaid orders past hold + 1 min grace: paid-meanwhile (missed webhook) are marked paid, the rest are cancelled and their stock restored; the gateway order is terminated best-effort. Customer cancel of an unpaid order does the same.

**Money-risk decisions (please review).**
- A **paid** online order cannot be cancelled by the customer in the app (409, "contact support"): refunds are NOT automated, so cancelling would leave money unrecorded.
- If the **shop rejects** a paid order, or a payment lands on an order already cancelled/expired, the order gets `refundRequired: true` (and the `duo_face_payments` record `paid_needs_refund`) and a server warning is logged. **Nothing refunds automatically and there is no admin screen to see these yet**: someone must refund in the Cashfree dashboard until a refund/admin feature is built.
- Minimum online order Rs 1 (Cashfree minimum). Fees are still zero.

**New data.** `duo_face_payments/{cf_<hash>}` (provider, orderId, customerId, amountPaise, status created/paid/expired/amount_mismatch/paid_needs_refund, timestamps). Order fields added: `paymentExpiresAt`, `paidAt`, `refundRequired`.

**Config.** `CASHFREE_APP_ID`, `CASHFREE_SECRET_KEY`, `CASHFREE_ENV` (sandbox default), `PUBLIC_BASE_URL` (HTTPS, must be reachable by Cashfree for the webhook). Unset = online payment off (`GET /customer/config` says so; the app shows only cash on delivery; online orders answer 503).

**Notes.** The Cashfree SDK script on the checkout page has no SRI hash on purpose (single unversioned URL; a pin would break on their updates); CSP restricts scripts to this server and `sdk.cashfree.com`. The checkout/return pages are `no-store` with no Referer because the session id is in the URL.

**Verified:** server tests (849 pass) incl. gateway request/response mapping, signature over raw bytes through the real Express app, amount tampering, a lying webhook, late payment after cancel, expiry/sweep/outage, refund flags; app typecheck/lint; browser click-through in preview mode (choose online -> awaiting payment with countdown -> pay -> paid, cancel hidden; COD unchanged). **Not verified:** any real call to Cashfree (no sandbox credentials were available), the checkout page loading Cashfree's SDK, a real webhook delivery, the in-app browser on a device. The first thing to do with sandbox keys is one test payment end to end.

## C5 implementation notes (2026-10-06): admin role and refunds

Closes the money gap from C4. Owner choices: admins identified by an **env allowlist**; scope **refunds only**; **full refunds only**.

- **Admin identity.** `ADMIN_FIREBASE_UIDS` (server `.env`, comma-separated Firebase UIDs). `DuoFaceRoleResolver` returns `role: 'admin'` for exactly those UIDs, before any identity lookup; nothing a client sends can create an admin, and a stored identity document cannot grant it. `/admin/*` runs authenticateFirebase -> resolveRole -> requireRole('admin') and is rate limited. An admin UID is only an admin (use separate accounts for shop/driver work).
- **Endpoints.** `GET /admin/me`, `GET /admin/refunds` (open = due/processing/failed, plus the 50 latest refunded), `GET /admin/refunds/:orderId`, `POST /admin/refunds/:orderId` (refund in full), `POST /admin/refunds/:orderId/refresh`. No request carries an amount: the refund is always the amount actually paid (from `duo_face_payments.paidAmountPaise`), never the order total or anything client-sent.
- **Never twice.** The refund is written to the order as `processing` in a transaction BEFORE Cashfree is called, with a refund id derived from (order, attempt) and a derived `x-idempotency-key`. Every path first asks Cashfree whether that refund id exists and only creates it if it does not. A double click, a retry or a crash between "recorded" and "sent" therefore resumes the same refund. Only Cashfree cancelling/rejecting a refund (`failed`) allows a new attempt, with a new id. Cashfree statuses: SUCCESS -> refunded (`refundRequired` cleared, payment record `refunded`); PENDING / PENDING_APPROVAL / ONHOLD -> stays processing; CANCELLED / REJECTED -> failed.
- **Settling.** The 60 s timer (same one as payment expiry) re-checks every processing refund. If Cashfree is unreachable the refund stays `processing` (never lost, never doubled) and the admin sees a clear message.
- **Audit.** Each step writes `order_events` (`refund_requested_<n>`, `refund_completed`, `refund_failed_<n>`) with the admin's uid as actor (`system` when the timer finishes it).
- **Admin screens** (in the existing `app/`, role-based like merchant/driver): refunds list (Needs refund / In progress / Refunded), detail with reason, amounts, customer phone (tap to call) and a "Refund Rs X" button behind a confirmation. In progress shows only "Check status". Preview: `EXPO_PUBLIC_UI_PREVIEW=admin`.
- **Setup:** `docs/integration/FIREBASE_SETUP.md` section 9.
- **Verified:** server tests (880 pass) incl. a double click creating exactly one refund at a gateway that behaves like Cashfree's idempotency, outage/retry/failed-attempt paths, access control on every admin endpoint (merchant, driver, customer and a look-alike uid all 403), and the Cashfree refund request/response mapping; app typecheck/lint; browser click-through in admin preview (list -> detail -> refund -> processing -> check -> refunded, list updates). **Not verified:** any real Cashfree refund (no sandbox keys yet), real admin sign-in, refund status values beyond the documented set.
- **Deliberately not built:** partial refunds, refund notes/reasons chosen by the admin, notifying the customer, an order search, KYC verification of drivers/merchants (still nothing can become `verified`), and refunding COD orders (nothing is collected online).

## C6 implementation notes (2026-10-06): notifications and KYC review

Owner choices: **inbox + push**; KYC approval **changes status and notifies only** (nothing is blocked yet).

### Notifications
- **One path.** `Notifier` (server) writes each notification to the recipient's inbox (`duo_face_inbox/{uid}/items/{type:ref}`) and then pushes it to their registered devices. The inbox write is also the once-only guard (same recipient + type + reference is sent at most once, however often the event repeats). The inbox is the source of truth: push is best effort (no push on web, Expo Go or iOS yet), so nothing is lost when it fails. `Notifier` never throws. The original four customer delivery notifications (`NotificationService`) are untouched.
- **Catalog.** Customer: payment received, order confirmed, order declined, order cancelled (payment timed out), delivery partner nearby (within 300 m of the address, only while carrying the order, GPS accuracy must be <= 100 m, checked at most every 20 s, once per order), refund started, refund completed (plus the existing assigned/accepted/picked up/delivered). Shop: new order (cash orders at once, online orders when paid), customer cancelled, driver accepted / picked up. Driver: new delivery offer (a re-offer is a new notification). Shop and driver: KYC approved / rejected. Admin: refund needs action, KYC submitted.
- **Hooks.** Events fire AFTER the service's own change is saved, in the background, and can never fail the caller. They are a no-op until `server.ts` installs the real implementation (same pattern as the delivery effects), so tests and the bare app send nothing. Recipients are resolved server-side (order -> customer; shop -> merchant uid; driver -> account uid; admins = allowlist).
- **Content.** Static copy only: no names, addresses, phone numbers or amounts (it appears on lock screens). The push carries only `type` and optional `orderId`.
- **Endpoints (any signed-in role, scoped to the verified uid only):** `POST/DELETE /notifications/device`, `GET /notifications`, `POST /notifications/:id/read`, `POST /notifications/read-all`. The old `/customer/notifications/device` still works.
- **Apps.** Bell with unread count and one inbox screen in the customer app and in the Merchant/Driver/Admin app; a tap opens the right place for the role (order, refund, KYC queue, profile). Push is registered after sign-in on Android builds (and unregistered on sign-out). Not verified on a device.

### KYC review (admin)
- **Queue** = profiles with KYC or bank in `pending_review`, oldest first. **Detail** = the owner-style profile (masked Aadhaar/PAN/licence/account numbers, short-lived photo links); full numbers never leave the server.
- **Decision** per section (`kyc`, `bank`): approve, or reject with a required reason (3-200 characters). Applied only if the profile is still exactly the version the admin opened (atomic compare-and-set on `updatedAt`), so details cannot be swapped between viewing and approving; a 409 tells the admin to reopen it. Only a section in review can be decided. A driving licence past its expiry date cannot be approved (reject instead).
- **Record.** Each decision (who, when, why) is saved on the profile in the same write as the status, with a bounded history. The applicant sees the reason only while the section is rejected; editing and saving sends it back to review (and alerts the admins again).
- **Effect.** Status and notifications only: approval does not yet block or unblock anything (going on duty, shop visibility, payouts). Gating is a separate, deliberate change.
- **Endpoints.** `GET /admin/verifications`, `GET /admin/verifications/:kind/:ownerId`, `POST /admin/verifications/:kind/:ownerId/:section` (strict body: `decision`, `reason`, `version`).

### Verified / not verified
Server: 953 tests pass, including every hook point (fires once, not on failure, not on repeats), recipients per event, inbox isolation per user over HTTP, and all the review safety cases. Apps: typecheck and lint clean; browser click-throughs in preview mode (customer: online order -> bell and inbox fill as it progresses -> tap opens the order -> mark all read; admin: bell/inbox -> KYC queue -> masked detail with photos -> approve KYC -> reject bank needs a reason -> queue updates). **Not verified:** real push delivery (no Firebase project / device), the "nearby" check against real GPS and geocoding, merchant/driver bells and the applicant rejection note on screen (type-checked only), Firestore inbox queries and indexes (in-memory fakes only).

## C7 (2026-10-06): wiring audit between the customer, shop and driver apps

The real server (all routes, services and stores, unchanged) is run end to end against an in-memory Firestore (`server/tests/e2e/`), driven over HTTP with each person's own token, plus a contract test that every endpoint the apps call exists. This found real gaps that no unit test could, now fixed:

1. **A newly registered shop was invisible to customers.** Registration now creates the customer-visible `shops/{id}` record in the same transaction, under the **same id** as the Duo-Face shop and linked to it, **closed** until the owner opens it. (Supersedes the old "do not assume the ids are equal" caution for registered shops; linking an existing external shop is still supported.)
2. **Stock the shop set was never what customers saw** (stock was keyed by the internal shop id, the catalog and orders by the customer-facing id). Stock is now keyed by one function, `stockKey(shop)` = customer-facing id everywhere.
3. **Shops could not create products.** `POST /merchant/products` (name, description, price in paise, starting stock; product + stock written in one transaction) and `PATCH /merchant/products/:id` (name, description, price, hide/show). Another shop's product is a 404. Photos are not included (they need R2).
4. **The shop app had no order buttons.** Accept / reject / start preparing / mark ready on the order screen (the server owns the allowed moves; reject asks for confirmation).
5. **No open/closed switch.** `GET /merchant/shop`, `PUT /merchant/shop/open`; a closed shop is visible but cannot be ordered from. The shop's name and address are kept in step with its profile.
6. **The customer's saved GPS point was ignored** (map destination, driver navigation and "nearby" needed a paid geocoder). It is now used first everywhere; geocoding is only a fallback.
7. **The customer's four delivery notifications were push-only.** They now also reach the in-app inbox (same once-only key as the new notifier).
8. **Catalog lookups dropped the document id**, so products without an embedded `id` field were silently invisible to the shop. Fixed at the source.

Also: production wiring (hubs, effects, dispatch, codes, notifications) moved into `server/src/runtime.ts`, called by `server.ts` and by the end-to-end tests, so tests exercise the real wiring.

**Covered by end-to-end tests (real server, in-memory database):** onboarding from registration; the full order (place, shop works it, driver offered / accepts / picks up, delivery code, tracking incl. destination, nearby alert, delivered with the code, every inbox); cancel, reject, the last-unit race between two customers, closed shop, hidden product, price change; privacy between customers, shops, drivers and admins; KYC review from submission to the owner's notification. **Not covered:** online payment and refunds across the apps (need a Cashfree account), real Firestore behaviour (indexes, transaction contention, security rules), real push, GPS, and the apps' screens beyond the browser previews.

