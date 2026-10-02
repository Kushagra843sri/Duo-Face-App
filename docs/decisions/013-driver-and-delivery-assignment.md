# 013 — Driver identity and delivery assignment foundation

## Status

Accepted 2026-09-29 (Phase 12, following `011-merchant-order-boundary.md` and `012-merchant-mobile-architecture.md`).

## Driver identity model

`duo_face_drivers/{driverId}` (`server/src/types/duoFaceDriver.ts`) holds only `driverId`, `firebaseUid`, `name`, an optional `phoneNumber`, `status` (`active`/`suspended`), and timestamps. No KYC document metadata, no bank/payment fields — those are a future phase's design, exactly as `006-duo-face-identity-model.md` deferred merchant-side financial fields off the identity model itself.

## Driver ↔ Firebase UID relationship

Same shape as the merchant side (`006`): `duo_face_identities/{firebaseUid}` carries `{role: 'driver', driver: {driverId}}`, and `duo_face_drivers/{driverId}` carries `firebaseUid` pointing back. `DriverService.getById`/`getByFirebaseUid` (`server/src/services/driverService.ts`) throw rather than silently repair a mismatch between the two. `requireActiveDriver` (`server/src/middleware/requireActiveDriver.ts`) re-verifies this cross-reference on every request — a driver profile that exists but points to a different `firebaseUid`, or is suspended, is a 403, identical to `requireActiveMerchantShop`'s handling of an inconsistent shop.

## Driver provisioning boundary

`DriverProvisioningService.provisionDriver` (`server/src/services/driverProvisioningService.ts`) mirrors `MerchantProvisioningService.provisionMerchantShop`: it rejects an existing identity, rejects an orphaned driver profile already referencing the `firebaseUid`, and writes `duo_face_identities` + `duo_face_drivers` atomically via a narrow `DriverProvisioningTransaction` (one Firestore transaction, two `tx.set()`s — never a partial write). It is not wired to any route. No self-registration, no client-supplied role, no "Become a Driver" endpoint exists — the same reasoning as `006`/`007`: no secure operations-authorization mechanism exists yet to gate who may call this, so it stays a domain operation only, for a future ops/admin phase to expose deliberately.

Unlike a merchant's `shopId` (which the Customer App's `shops` collection effectively constrains provisioning around), a driver has no Customer App equivalent to key off, so `driverId` is generated server-side via Node's built-in `crypto.randomUUID()` — no new dependency, purely Duo-Face-owned.

## Assignment ownership

`duo_face_delivery_assignments/{assignmentId}` (`server/src/types/deliveryAssignment.ts`) references `orderId` (the Customer App order's own Firestore document id) and `customerAppShopId` — it never copies the order document. `DeliveryAssignmentService.assignDriver` verifies, server-side, before writing: the order exists, the order's own `shopId` actually equals the supplied `customerAppShopId`, the driver exists and is `active`, and — atomically, via `FirestoreDeliveryAssignmentStore.createIfNoActiveAssignmentForOrder`'s Firestore transaction — that no conflicting *active* assignment already exists for that order. The transaction queries only by `orderId` (single-field equality, auto-indexed) and filters active statuses in the callback, deliberately avoiding an unconfirmed composite index — the same caution `011` applied to Customer App order queries.

Reads enforce the mirror-image ownership check: `GET /driver/assignments` and `GET /driver/assignments/:id` scope strictly to `req.driver!.driverId` (never a `?driverId=` query param); `GET /merchant/deliveries` scopes strictly to `req.shop!.customerAppShopId` (never a client-supplied shop id). A driver requesting another driver's assignment by id gets a 404, not a 403 — existence is never leaked, matching the same convention `011` established for merchant order detail.

## Assignment statuses vs. Customer App order status

`assigned | accepted | rejected | picked_up | delivered | cancelled` belong entirely to the Duo-Face assignment and are never written into the Customer App order's own `status` field. The two lifecycles are deliberately kept separate: the order's `status` (confirmed in `011` to really only ever move `pending → cancelled` in the actual Customer App source) has nothing to do with delivery-assignment progress, and conflating them would mean Duo-Face writing into a collection it doesn't own. A future phase will need to design the actual synchronization policy between the two (e.g., does `delivered` on the assignment ever need to surface back to the customer?) — deliberately out of scope here.

## Why assignment creation is service-level only

Same reasoning as driver provisioning: `assignDriver` verifies real preconditions but has no route. The brief's scope note that "merchant/admin provisioning will own assignment creation for now" describes a future authorization mechanism that doesn't exist yet — inventing one now would mean guessing at an authorization model this project has consistently avoided guessing at since Phase 3. Assignment *reads* (`GET /driver/assignments*`, `GET /merchant/deliveries`), by contrast, reuse the exact same authenticate → resolveRole → requireRole → requireActive* guard chain every other route already uses, so exposing them carries no new authorization risk.

## Why GPS/realtime/mobile UI are deferred

Unchanged from every prior phase's boundary: this phase is the domain model and its read APIs only. GPS, live tracking, Socket.io events, driver earnings/payouts, KYC upload, payment collection, route optimization, and any Driver mobile screen are all explicitly out of scope (per the Phase 12 brief) and require their own design decisions this phase doesn't make.

## No app-side changes

This phase touches only `server/`. No Driver navigation, screens, or API client methods were added to `app/` — the merchant mobile foundation (`012`) is unaffected.
