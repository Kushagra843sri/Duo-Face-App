# Customer App integration requirements

**The Customer App is "Allz Bharat."** Confirmed by inspecting its real source code (`Allz_Bharat_Final_Handover/source_code/`, developer handover package, reviewed 2026-09-28) — not just its documentation. Sections below marked **CONFIRMED** are sourced from actual files (cited inline); nothing here is inferred from the handover PDF's prose alone. Sections still marked **UNKNOWN** genuinely couldn't be answered from the source snapshot and need the project owner.

See `docs/decisions/002-customer-app-integration.md` for the architecture decision this unblocks, and `docs/integration/API_CONTRACT_TEMPLATE.md` for how endpoints/events get documented once implemented.

**Read this first**: Allz Bharat is an *archived, undeployed* snapshot — "Development Paused," 0 live Cloud Functions, 0 live secrets, strict zero-access handover (no previous developer's Firebase project, credentials, or Cashfree account included). There is currently no *running* Customer App backend anywhere — whoever continues this needs to create a fresh Firebase project and deploy it before anything below is reachable over the network.

---

## 1. Customer App Overview

- **Status**: CONFIRMED
- Allz Bharat is a hyperlocal quick-commerce platform (kirana/neighborhood stores). Current scope is the customer-facing app only — no merchant portal or rider app exist yet (see §5, §8).
- Stack: Flutter 3.x/Dart (Riverpod, GoRouter) mobile client; Firebase Cloud Functions v2 (TypeScript, Node 18+) backend; Cloud Firestore database; Cashfree payment gateway.
- Source: `documentation/Allz_Bharat_Developer_Handover_Guide_FRESH_SETUP.pdf` §2–3; `source_code/functions/package.json` (`firebase-admin ^13.1.0`, `firebase-functions ^6.3.2`, Node `>=18`).

## 2. Environment / Base URLs

- **Status**: CONFIRMED (architecture) / no live URL exists yet
- No environment is deployed. Once a Firebase project is created, callable functions (`createPaymentOrder`, `verifyPayment`) are invoked through the Firebase SDK (`httpsCallable`), not a REST base URL directly — Duo-Face's server would call them via `firebase-admin`'s equivalent or the Cloud Functions REST invocation format `https://<region>-<project-id>.cloudfunctions.net/<functionName>`. The `cashfreeWebhook` function *is* a plain HTTPS endpoint at that same pattern.
- Source: `source_code/functions/src/index.ts`; `source_code/functions/src/handlers/*.ts` (`onCall` vs `onRequest`).
- **Still unknown**: the actual project ID/region once a real project exists.

## 3. Authentication

- **Status**: CONFIRMED
- Firebase Authentication, Phone sign-in (OTP), 6-digit code via Pinput on the client. Cloud Functions callables receive `request.auth.uid` — a verified Firebase ID token's subject, already authenticated by the Functions runtime itself (no custom JWT issuer/signing to configure). Firestore security rules independently re-check `request.auth.uid` on every read/write.
- Firebase ID tokens expire hourly and refresh automatically client-side; nothing custom.
- **No role claim exists anywhere in this token or in Firestore.** CLAUDE.md's "role is read from the JWT on the server" rule must mean Duo-Face's *own* JWT/session (minted after Duo-Face verifies the Firebase ID token), or Firebase custom claims Duo-Face sets itself via `admin.auth().setCustomUserClaims()` — not something already present in Allz Bharat's tokens.
- Source: `source_code/customer_app/firestore.rules` (`request.auth.uid`); `source_code/functions/src/handlers/createPaymentOrder.ts` lines 23–31.

## 4. User / Role Model

- **Status**: CONFIRMED
- `users/{uid}` — Firestore document ID *is* the Firebase Auth UID directly. Fields: `uid`, `phoneNumber`, `name`/`displayName`, `email?`, `createdAt`. Subcollection `users/{uid}/addresses/{addressId}`: `label`, `fullAddress`, `phoneNumber`, `isDefault`, `createdAt` — **no lat/lng**.
- No role, permission, or account-type field exists on the user document or anywhere else in the schema.
- Source: `source_code/customer_app/lib/features/auth/models/app_user.dart`; `source_code/customer_app/lib/features/addresses/models/address.dart`; `source_code/customer_app/firestore.rules` lines 6–16.
- **Conclusion**: role is entirely Duo-Face's own concept, exactly as `server/src/types/auth.ts` already assumes. Adding it means a new field on `users/{uid}` (or a new collection) — never touching what's there.

## 5. Merchant / Store Model

- **Status**: PARTIALLY CONFIRMED
- `shops/{shopId}` exists as a **read-only catalog entity** for customers: `name`, `address`, `imageUrl`, `rating`, `isOpen`, `isActive`, `createdAt`. Firestore rules make it public-read, no client writes (`allow write: if false`) — so even the Cloud Functions side has no shop-management flow, only the seed script writes it directly with the Admin SDK.
- **No merchant/owner account is linked to a shop anywhere** — no `ownerId`/`merchantUserId` field, no merchant login, no merchant-side code at all.
- Source: `source_code/customer_app/lib/features/shops/models/shop.dart`; `source_code/tools/seed_commerce/seed.js` lines 75–94; `source_code/customer_app/firestore.rules` lines 25–30.
- **Implication for M2**: Duo-Face's merchant interface needs a new way to link a Duo-Face user to a `shops/{shopId}` document (new field or mapping collection) — there's no existing relationship to read.

## 6. Product / Inventory Model

- **Status**: CONFIRMED
- `products/{productId}`: `shopId`, `categoryId`, `name`, `description?`, `price` (JS `number`, e.g. `28`, `250` — **rupees as a float, not integer paise**), `imageUrl?`, `inStock` (**boolean**, not a quantity), `isActive`, `createdAt`.
- **There is no stock quantity field anywhere.** CLAUDE.md's atomic `{ stock: { $gte: qty } }` / `$inc` decrement pattern has nothing to operate on today — it assumes a field that doesn't exist in this schema. Server-side price recalculation already exists and is done correctly (see §10), but nothing enforces stock at order time beyond the boolean.
- Source: `source_code/customer_app/lib/features/products/models/product.dart`; `source_code/functions/src/services/pricing.service.ts` lines 59–80 (`price: typeof productData.price === "number" ? productData.price : 0`).
- **Implication**: Duo-Face's merchant inventory management is additive — a new numeric stock field (and its own atomic-decrement logic) needs to be designed, not adapted from something existing. Money conversion (float rupees → integer paise) needs an explicit boundary wherever Duo-Face reads/writes this collection, per CLAUDE.md's own paise rule.

## 7. Order Model

- **Status**: CONFIRMED
- `orders/{orderId}`: `customerId`, `shopId`, `shopName`, `items[]` (`productId, name, price, quantity, subtotal` — snapshotted at order time), `delivery` (`addressId?, label, fullAddress, phoneNumber`), `pricing` (`subtotal, deliveryFee, platformFee, total`), `status`, `paymentStatus`, `paymentOrderId?`, `paymentId?`, `paymentMethod?`, `paidAt?`, `createdAt`, `cancelledAt?`, `cancellationReason?`.
- **Status enum** (`OrderFulfillmentStatus`): `pending → confirmed → preparing → ready_for_pickup → out_for_delivery → delivered`, plus terminal `cancelled` / `rejected`. This is a ready-made source for `services/orderState`'s allowed-transition map — no transition logic exists server-side yet (nothing currently moves an order past `pending`), but the enum itself is real.
- **Ownership**: `customerId` field, verified server-side. **No merchant/driver ownership field exists** — nothing currently reads/writes `orders` on behalf of a shop or a driver.
- **Creation is server-only**: Firestore rules set `allow create: if false` on `orders` — a `createPaymentOrder` callable writes a `payment_intents/{id}` draft (server-recalculated pricing only), and `verifyPayment` or the Cashfree webhook atomically promotes it to `orders/{id}` inside a Firestore transaction (`OrderPromotionService.promoteIntentToOrder`) — idempotent, checked for existing promotion, checks intent expiry, checks amount/currency match within a tolerance. This is solid, reusable logic worth studying before Duo-Face writes its own order-transition logic.
- Customer cancellation: rules allow a client to flip `status: "pending" → "cancelled"` themselves, updating only `status`, `cancelledAt`, `cancellationReason` — nothing else.
- Source: `source_code/functions/src/types/order.types.ts`; `source_code/functions/src/services/promotion.service.ts`; `source_code/customer_app/firestore.rules` lines 47–62.

## 8. Delivery Model

- **Status**: CONFIRMED ABSENT
- No driver/rider entity, no assignment field on `orders`, no delivery-tracking code anywhere in this snapshot. Confirmed "Not Started" in the handover doc and confirmed by absence in the actual schema and Functions code.
- **Implication**: Duo-Face's driver interface (M3) is fully greenfield here — no existing concept to integrate with, only new fields/collections to add (per CLAUDE.md's "only add new fields or collections" rule).

## 9. Realtime Events

- **Status**: CONFIRMED
- No Socket.IO, SSE, or custom WebSocket layer exists in the Cloud Functions backend. The Flutter client almost certainly uses Firestore's own native real-time snapshot listeners directly against `orders`/`products` (standard Firestore usage) rather than a custom event system — this wasn't independently verified in the Flutter UI code, but no server-side push mechanism exists to conflict with.
- Source: `source_code/functions/src/index.ts` (only 3 exports total: 2 callables + 1 webhook, no pub/sub or realtime-specific code).
- **Implication**: Duo-Face's planned Socket.io/Redis realtime layer (CLAUDE.md) is entirely additive and won't collide with anything existing.

## 10. Payment System

- **Status**: CONFIRMED
- Gateway: **Cashfree** (not Razorpay — resolves the ambiguity in `SPEC.md.docx`). Code is complete but **never run against live/sandbox credentials** ("Incomplete/Unverified" per the handover doc; 0 live secrets set).
- Flow: `createPaymentOrder` (callable, auth required) → server recalculates price from Firestore → creates a Cashfree gateway session → writes `payment_intents/{orderId}` **only if** the gateway session succeeds → client completes payment via Cashfree's SDK using the returned session → `verifyPayment` (callable) or `cashfreeWebhook` (HTTPS, HMAC-SHA256 signature over `x-webhook-signature`/`x-webhook-timestamp`, replay-protected) → `OrderPromotionService` atomically promotes the intent to a final `orders/{id}` document.
- `PaymentStatus` enum: `pending | paid | failed | cancelled | refunded`.
- Required secrets (Firebase Secret Manager, per the handover's explicit directive — never `.env`/committed): `CASHFREE_SECRET_KEY`, `CASHFREE_APP_ID`, `CASHFREE_ENV`.
- No settlement/payout model exists — nothing about merchant payouts, since no merchant flow exists yet.
- Source: `source_code/functions/src/handlers/createPaymentOrder.ts`, `verifyPayment.ts`, `cashfreeWebhook.ts`, `services/payment.service.ts`, `services/promotion.service.ts`.

## 11. Firebase

- **Status**: CONFIRMED
- Firebase is used for Auth (Phone) and Firestore (database) — not just "possibly," it's the entire backend. **No existing live Firebase project** — the handover is strictly zero-access; a new project must be created by whoever continues development, with Phone Auth and Firestore (Production Mode) enabled fresh.
- FCM: no push-notification code found in this snapshot (not confirmed absent everywhere in the Flutter UI, but nothing in `functions/` sends FCM messages).
- Source: `documentation/Allz_Bharat_Developer_Handover_Guide_FRESH_SETUP.pdf` §1, §7 (zero-access directives); `source_code/functions/src/index.ts`.

## 12. File / Object Storage

- **Status**: NOT OBSERVED
- `imageUrl` fields exist on `shops`/`products` but are empty strings in the seed data, and no upload/Cloud Storage code was found in the reviewed files. Not confirmed absent everywhere (Flutter UI wasn't fully audited), but nothing in the backend touches object storage.
- **Still unknown**: whether any object storage is planned for Allz Bharat itself; doesn't block Duo-Face's own R2 usage for KYC either way, since they'd be entirely separate buckets/purposes.

## 13. Error Contract

- **Status**: CONFIRMED
- Callable functions throw `HttpsError(code, message)` — Firebase's own typed error codes (`unauthenticated`, `invalid-argument`, `not-found`, `permission-denied`, `failed-precondition`, `internal`, etc.), delivered through the Firebase SDK's callable-function error channel, not a custom JSON body over plain HTTP.
- The webhook (`cashfreeWebhook`, a plain HTTPS function) returns `{ status: "OK" | "ERROR", message, orderId? }` with a matching HTTP status code — this one *is* a conventional JSON body.
- Source: `source_code/functions/src/handlers/createPaymentOrder.ts`, `cashfreeWebhook.ts`.

## 14. Rate Limits

- **Status**: UNKNOWN
- Nothing in the reviewed code enforces or documents rate limits. Firebase Cloud Functions has platform-level quotas/concurrency limits, but nothing Allz-Bharat-specific was found.

## 15. Security Requirements

- **Status**: CONFIRMED
- Full Firestore rules reviewed (`source_code/customer_app/firestore.rules`): `users/{uid}` and its `addresses` subcollection are owner-only read/write; `categories`/`shops`/`products` are public-read, no client writes; `payment_intents` are owner-readable only, never client-writable; `orders` are owner-readable, never client-creatable, and only updatable by the owning customer to cancel a still-`pending` order (and only those three fields).
- Cloud Functions require an authenticated Firebase context for both callables; the webhook requires a verified HMAC-SHA256 signature.
- Explicit directive from the handover: never commit private keys, service-account JSON, `.env` files, or the Cashfree secret key/GitHub tokens — secrets belong exclusively in Firebase Secret Manager.
- Source: `source_code/customer_app/firestore.rules`; `documentation/Allz_Bharat_Developer_Handover_Guide_FRESH_SETUP.pdf` §13.

## 16. Test / Staging Environment

- **Status**: CONFIRMED — none exists yet
- Strict zero-access handover: whoever continues must create their own fresh Firebase project (Phone Auth test numbers + Firestore in Production Mode), run `flutterfire configure`, deploy `firestore.rules`, and run `tools/seed_commerce/seed.js --confirm` (16 seed documents: 4 categories, 2 shops, 10 products) to get any usable environment at all — dev or otherwise.
- Local test suites do pass without any of that: `functions/` — 16/16 unit tests (`npm test`); `customer_app/` — 122/122 tests + `flutter analyze` clean (per the handover doc; not independently re-run here).

## 17. Required Credentials / Access

- **Status**: CONFIRMED (what's needed) / not yet provisioned
- To do anything real: (1) a Firebase project — Console access to create one, or membership on an existing one if the project owner has since created one; (2) a downloaded service-account JSON for Admin SDK access (seeding, and eventually Duo-Face's server reading/writing Firestore); (3) Firebase CLI login; (4) a Cashfree account (sandbox keys) if payment work continues, set via `firebase functions:secrets:set`.
- **Still unknown**: who administers the Firebase project long-term (billing owner, IAM), and whether Duo-Face's server gets its own scoped service account or shares the same one used for Allz Bharat's own Functions.

## 18. Open Decisions

- **Status**: NARROWED, not fully closed
- **Resolved by this review**: database engine (Firestore), auth mechanism (Firebase Phone Auth + ID tokens), order/payment model, realtime (none exists), payment gateway (Cashfree).
- **Resolved by the project owner (2026-09-28)**: Duo-Face's server stays Node.js + Express (per CLAUDE.md) rather than becoming Cloud Functions itself; it reaches Firestore/Cloud Functions directly (Admin SDK / callable invocation) rather than through a separate walled-off service. See `docs/decisions/002-customer-app-integration.md`.
- **Still open**: who owns/administers the (not yet created) Firebase project long-term; whether Duo-Face gets a distinct scoped service account; rate limits (§14); object storage ownership (§12).
- **Resolved 2026-09-28 (Phase 1.75)**: the CLAUDE.md conflicts this review surfaced (MongoDB, integer-paise-only, Mongo-syntax stock decrement) have been reconciled directly in `CLAUDE.md` — see `docs/decisions/003-inventory-and-financial-boundaries.md` for the inventory/financial boundary rationale.

## 19. Identity & Role Mapping Evidence (Phase 3)

- **Status**: CONFIRMED ABSENT (both merchant and driver mapping)
- Direct source review, not inference from §4/§5/§8's prose — every row below cites the exact file. Full reasoning and implications: `docs/decisions/005-identity-and-role-mapping.md`.

| Question | Actual evidence | Source file | Status |
|---|---|---|---|
| Firebase UID → user document | `users/{uid}`, doc ID = Firebase Auth UID; written by `createUserProfile({uid, phoneNumber, name, displayName, createdAt})` | `customer_app/lib/features/auth/data/user_repository_impl.dart` | confirmed |
| User role field | No `role` field written or read anywhere — repo-wide grep, zero matches outside compiled `lib/` dupes | (repo-wide grep) | absent |
| User → shop relationship | `createUserProfile` writes only uid/phoneNumber/name/displayName/createdAt — no shop link | `customer_app/lib/features/auth/data/user_repository_impl.dart` | absent |
| Shop → owner relationship | `Shop` model/doc has no owner/admin field: `id, name, address, imageUrl, rating, isOpen, isActive, createdAt` only | `customer_app/lib/features/shops/models/shop.dart`; `tools/seed_commerce/seed.js` | absent |
| Existing merchant entity | No `merchants` collection/model/route anywhere; "merchant" appears only in a descriptive code comment | (repo-wide grep) | absent |
| Existing driver entity | No `drivers`/`riders`/`deliveryPartners` collection, model, or field anywhere | (repo-wide grep, zero matches) | absent |
| Driver → user relationship | N/A — no driver entity exists to relate | — | absent |
| Order → shop relationship | `OrderDocument.shopId: string` on every order | `functions/src/types/order.types.ts` | confirmed |
| Order → driver relationship | No driver/rider field on `OrderDocument` | `functions/src/types/order.types.ts` | absent |
| Firebase custom claims | `setCustomUserClaims` never called anywhere in the Functions or Flutter code | (repo-wide grep) | absent |

---

## Answering this checklist

Sections marked CONFIRMED above are sourced from `Allz_Bharat_Final_Handover/source_code/` reviewed 2026-09-28 — re-verify against that snapshot's actual path if you need the exact line again. Anything still UNKNOWN or NOT OBSERVED needs the project owner directly. Once a section is answered, revisit the corresponding `server/src/integrations/customerApp/*` interface — interfaces should get more specific as real answers land.
