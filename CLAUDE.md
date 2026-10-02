# Duo-Face App

One React Native (Expo) app with two interfaces — Merchant and Delivery Partner — chosen by the logged-in user's `role`. It works with the client's existing Customer App database and API.

Full spec: `docs/SPEC.md`. Read the relevant section before building a feature. If the spec and this file disagree, ask me.

## Stack
- App: React Native + Expo, Expo Router, NativeWind, Lucide icons, TypeScript
- Server: Node.js + Express, Socket.io with Redis adapter, TypeScript
- DB: client's existing Cloud Firestore (the Customer App's — "Allz Bharat" — Firebase project), accessed via the Firebase Admin SDK from the Duo-Face server only, never from the mobile app. Existing collections/fields are documented in `docs/integration/CUSTOMER_APP_REQUIREMENTS.md`, sourced from the real Customer App code, not assumed. New Duo-Face-owned collections are designed separately (see `docs/decisions/002-customer-app-integration.md`, `docs/decisions/003-inventory-and-financial-boundaries.md`)
- Services: Google Maps (India pricing), Firebase (FCM + phone auth), Cloudflare R2, Razorpay

## Architecture

```
                 ┌────────────────────┐
                 │   Customer App     │
                 │  (Allz Bharat)     │
                 │ Existing Firestore │
                 │ Existing Auth      │
                 └─────────┬──────────┘
                           │
                    Firebase Admin SDK
                           │
                           ▼
                 ┌────────────────────┐
                 │ Duo-Face Backend   │
                 │ Express + TS       │
                 │                    │
                 │ Services           │
                 │ Integration Layer  │
                 │ Authorization      │
                 └─────────┬──────────┘
                           │
                      REST / WS
                           │
                           ▼
                 ┌────────────────────┐
                 │ Duo-Face Mobile    │
                 │ React Native/Expo  │
                 └────────────────────┘
```

The mobile app never receives Firebase Admin credentials and never talks to Firestore directly — only the Duo-Face server does, through the Admin SDK.

## Repo layout
- `app/` — Expo app
  - `app/(merchant)/` — merchant screens only
  - `app/(driver)/` — delivery partner screens only
  - `components/`, `api/`, `socket/` — shared
- `server/` — Express API
  - `routes/merchant/`, `routes/driver/`, `routes/auth/`
  - `services/` — all business logic and DB writes live here
  - `realtime/` — Socket.io events
- `docs/` — spec, schema, decisions

## Commands
- App: `cd app && npx expo start`
- Server: `cd server && npm run dev`
- Tests: `cd server && npm test`
- Lint/typecheck before every commit: `npm run lint && npm run typecheck`

## Rules that must never be broken
- The app never talks to the database directly. Every write goes through the API.
- Role is read from the JWT on the server. Never trust a role sent by the app. The Customer App's Firebase ID tokens carry no role claim, so exactly how an authenticated Customer App identity maps to Duo-Face merchant/driver authorization is still an open integration decision (see `docs/decisions/002-customer-app-integration.md`) — but this rule itself is not conditional on that: no route ever trusts a client-sent role, regardless of how identity mapping is eventually resolved.
- Every route checks role AND ownership (merchant → own store only, driver → own trips only).
- The Customer App's existing monetary fields (Firestore) are floats in rupees today — never silently reinterpret them; convert explicitly and document units wherever Duo-Face reads them at the integration boundary. Any new Duo-Face-owned financial data (wallet ledger, payouts, settlement) is stored as integer paise (or another explicitly lossless representation) — never floats. Never do financial arithmetic in floats anywhere in Duo-Face's own code, on either side of that boundary.
- Wallet balance is derived from the `wallet_ledger` collection. The ledger is append-only.
- Order status changes only through `services/orderState` using the allowed-transition map. Write every change to `order_events`.
- The Customer App's existing `products` documents have a boolean `inStock`, not a quantity — treat it as the existing availability signal only, read-only from Duo-Face's side. Real quantity-based inventory is a new, separate Duo-Face-owned model (not a `stock` field bolted onto the existing `products` document) — designed later, using Firestore transactions or `FieldValue.increment()` for atomic updates, never read-then-write. See `docs/decisions/003-inventory-and-financial-boundaries.md`.
- Delivery OTP is stored hashed; lock after 5 wrong attempts.
- KYC files go to the private R2 bucket via pre-signed URLs. Never log or return raw document URLs.
- Secrets only in `.env` (gitignored). Never hardcode keys. Update `.env.example` when adding one.
- Do not modify the Customer App's screens or existing fields in existing collections. Treat `users`, `shops`, `products`, `categories`, `orders`, and `payment_intents` as externally-owned/shared data — only add new fields to them, or add entirely new collections for Duo-Face-owned concepts (driver profiles, driver KYC metadata, delivery trips/assignments, driver location state, wallet ledger, settlement records, inventory quantity state, audit events). Exact new collection shapes are designed when each feature is built, not assumed now.

## Real-time conventions
- REST does writes; Socket.io only broadcasts what changed.
- Rooms: `merchant:<storeId>`, `driver:<driverId>`, `order:<orderId>`, `store:<storeId>`
- Event names: `order.created`, `order.status`, `order.offer`, `driver.location`, `trip.location`, `inventory.updated`, `store.status`
- Driver GPS goes to Redis GEO only, never to the DB per ping.

## Code style
- Small, focused functions; no business logic inside route handlers.
- Validate every request body with zod.
- Handle loading, empty and error states on every screen.
- Prefer existing libraries already in package.json before adding new ones; ask before adding a dependency.

## Testing
Write tests for: order state transitions, checkout stock decrement (including two buyers for the last unit), OTP verification and lockout, wallet ledger and payouts, role/ownership checks.

## How to work with me
- Build in milestone order: M1 foundation → M2 merchant → M3 driver → M4 launch.
- Use plan mode for anything touching more than 2–3 files; show the plan before coding.
- One feature per commit, with a clear message.
- If something in the spec is unclear or missing, ask instead of guessing.
- Out of scope unless I say so: admin panel, AI image scan, RazorpayX automated payouts, web versions.