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
