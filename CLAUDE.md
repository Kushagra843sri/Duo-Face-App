# Duo-Face App

One React Native (Expo) app with two interfaces — Merchant and Delivery Partner — chosen by the logged-in user's `role`. It works with the client's existing Customer App database and API.

Full spec: `docs/SPEC.md`. Read the relevant section before building a feature. If the spec and this file disagree, ask me.

## Stack
- App: React Native + Expo, Expo Router, NativeWind, Lucide icons, TypeScript
- Server: Node.js + Express, Socket.io with Redis adapter, TypeScript
- DB: client's existing MongoDB (use the same driver/ODM the Customer App uses) — collections and fields in `docs/schema.md`
- Services: Google Maps (India pricing), Firebase (FCM + phone auth), Cloudflare R2, Razorpay

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
- Role is read from the JWT on the server. Never trust a role sent by the app.
- Every route checks role AND ownership (merchant → own store only, driver → own trips only).
- Money is stored as integer paise. Never use floats for money.
- Wallet balance is derived from the `wallet_ledger` collection. The ledger is append-only.
- Order status changes only through `services/orderState` using the allowed-transition map. Write every change to `order_events`.
- Stock decrement at checkout is a single atomic `findOneAndUpdate` with `{ stock: { $gte: qty } }` and `$inc: { stock: -qty }`, never read-then-write. Use a MongoDB transaction when an order touches more than one document.
- Delivery OTP is stored hashed; lock after 5 wrong attempts.
- KYC files go to the private R2 bucket via pre-signed URLs. Never log or return raw document URLs.
- Secrets only in `.env` (gitignored). Never hardcode keys. Update `.env.example` when adding one.
- Do not modify the Customer App's screens or existing fields in existing collections. Only add new fields or collections.

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
