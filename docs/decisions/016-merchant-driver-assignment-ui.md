# 016 — Merchant driver-assignment UI

Status: implemented (Phase 15)

## Flow

1. Merchant opens **Orders**. Each row shows the order's Duo-Face delivery state (from the backend's `deliveryAssignment` field) and either **Assign Driver** or a link to the delivery.
2. **Assign Driver** opens `orders/assign/[orderId]`, which calls `GET /merchant/drivers`.
3. The merchant picks a driver and taps **Assign Driver**; a confirmation (native `Alert`, `window.confirm` on web because RN-web's `Alert` is a no-op) precedes the call.
4. `POST /merchant/deliveries` with `{ orderId, driverId }` only. On success the app `replace`s to `deliveries/[assignmentId]`.
5. Orders and Deliveries screens refetch when they regain focus, so the new state shows without manual refresh.
6. Submissions are guarded by a synchronous ref plus a disabled/loading button — a double tap sends one request.

## Driver discovery

`GET /merchant/drivers` → `[{ driverId, name, phoneNumber?, status }]`, active drivers only, sorted by name.

- Driver profiles are **global Duo-Face identities**, not shop-owned. There is deliberately no merchant↔driver ownership relationship; every active merchant sees the same pool.
- The route reads no query/body input — no client-side shop/driver/status filtering.
- The DTO is an explicit allow-list. `firebaseUid`, timestamps and raw Firestore documents never leave the server.
- Malformed profiles are skipped and logged, not fatal.
- Store addition: `DuoFaceDriverStore.listByStatus` — a single-field equality query, no composite index.

## Delivery DTO

`/merchant/deliveries` and `/merchant/deliveries/:id` now return `MerchantDeliveryAssignment`: ISO timestamps (never raw Firestore `Timestamp`s), plus `driverName` / `driverPhoneNumber` joined from the driver profile (`driverName: null` if the profile is gone). No `firebaseUid`.

`GET /merchant/orders` and `/merchant/orders/:orderId` gain `deliveryAssignment: { assignmentId, status } | null`, computed server-side from `duo_face_delivery_assignments` for the merchant's own shop (an active assignment wins over older terminal ones; otherwise the latest). The mobile client never infers assignment state from the Customer App order `status`, and never joins the two lists itself.

## Authorization boundaries

Every merchant route runs `authenticateFirebase → resolveRole → requireRole('merchant') → requireActiveMerchantShop`.

- `customerAppShopId` comes only from the authenticated merchant's shop; the POST body schema has no such field, and neither does the mobile client send one.
- Cross-shop orders → 404 (same as missing); cross-shop assignments → 404.
- Driver principals get 403 on all merchant routes; merchant principals cannot reach driver routes.
- Driver-facing APIs are unchanged.

## Conflict behavior

If the order already has an active (`assigned` / `accepted` / `picked_up`) assignment, the store's transactional check rejects with **409** (existing `AppError` path). An inactive driver is also 409; missing driver/order is 404. The UI shows the message, goes back, and the Orders screen refetches. An existing driver is never silently replaced. No reassignment or cancellation exists.

After a driver **rejects**, the assignment is terminal and no longer blocks a new one (existing backend rule), so the order shows its "Rejected" status *and* an Assign Driver button. That is a fresh assignment, not a reassignment feature.

## Why lifecycle stays Driver-only

Accept / reject / pick up / deliver are the driver's real-world actions and are authorized by driver ownership (`req.driver`). Letting a merchant mutate them would allow impersonation and break the audit meaning of each timestamp. The merchant delivery screens are read-only.

## Why Customer App orders stay read-only

`orders` is externally owned (CLAUDE.md). Assignment lives entirely in Duo-Face's `duo_face_delivery_assignments`; nothing writes the Customer App order or its `status`.

## Known limitations

- The merchant Deliveries screen is `deliveries/index.tsx` (with `_layout.tsx`), following the existing `orders/` and `assignments/` stack convention, rather than a single `deliveries.tsx`.
- The orders/deliveries lists do one driver lookup per distinct driver (deduped); fine at current scale, worth a batched read later.
- No mobile test framework exists (unchanged from earlier phases), so mobile behavior is validated by typecheck, lint, bundling and manual review only.
