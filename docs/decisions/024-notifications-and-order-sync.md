# 024 — Customer notifications & delivery-completion order sync

Status: implemented (Phase 23). **Tested with fakes and a mocked Firestore only. No real Customer App write, no real FCM push, no real Firebase were exercised.**

## 1. Why a Customer App write boundary exists

Until this phase Duo-Face never wrote a Customer App order (decision 011: no safe transition mechanism; the only related code was a throwing `updateOrderStatus` stub). When a driver completes a delivery, the customer's own app still shows the Customer App order status, so *something* must eventually move it. That is the first and only external write, and it is confined to one narrow, auditable path.

## 2. Exact supported transition

Duo-Face assignment `picked_up → delivered` triggers Customer App order **`out_for_delivery → delivered`**, nothing else. No other Duo-Face state (assigned, accepted, picked_up, rejected, cancelled) is synchronized, and no other Customer App status is ever written.

## 3. Customer App statuses (verified from source/docs)

`pending, confirmed, preparing, ready_for_pickup, out_for_delivery, delivered, cancelled, rejected` (`functions/src/types/order.types.ts`, decision 011). Historically only `pending` and `cancelled` are written by the Customer App. **Consequence: an order is almost certainly still `pending` when a driver delivers it, so in practice today the sync will report `protected_status` and write nothing.** Nothing in Duo-Face sets `out_for_delivery` (that would be a *picked_up* sync, deliberately not authorized here). The write path is correct and tested, but it only becomes effective once something (a future authorized phase, or the Customer App/merchant flow) moves orders to `out_for_delivery`.

## 4. Provider responsibilities

`CustomerAppOrderProvider` lost its generic `updateOrderStatus(orderId, status)`; it gained only `markOrderDelivered(orderId, expectedShopId)`. The target status and the single allowed source status are hard-coded inside; callers cannot pass a status. Result: `completed | already_delivered | protected_status | not_found | shop_mismatch`. External failures throw `CustomerAppUnavailableError` with category `transient | permanent` and no Firestore message, path or credentials (unknown errors are treated as transient; retries are bounded). It sets **only** `status` — verified by a test asserting `tx.update(ref, { status: 'delivered' })`.

`CustomerOrderSyncService.syncDelivered(orderId, shopId)` is the only caller: it pre-verifies (order exists, same shop, current status) then delegates the atomic write.

## 5. Atomicity / concurrency

The provider does read-status-then-write **inside one Firestore transaction** (`runTransaction`: `tx.get` → check → `tx.update`). That is a real compare-and-set on the order document for any writer that goes through Firestore: a concurrent change to the document makes the transaction retry and re-check. Limits, stated honestly: (a) it does not know about Customer App Cloud Functions/triggers that *react* to status changes (whether any depends on `delivered` is unverified); (b) the transaction logic was tested against a mocked Firestore, not the real one; (c) Customer App security rules do not apply to the Admin SDK, so nothing in the Customer App stops this write except this code.

## 6. Source of truth

- **Duo-Face assignment state is authoritative for Duo-Face** and never depends on the Customer App: `delivered` commits first; sync is an external side effect and cannot roll it back (or block it).
- **The Customer App order is authoritative for its own fulfillment status.** Duo-Face writes it only through the transition above and never overwrites `cancelled`, `rejected` or any unexpected status.

## 7. Sync record: `duo_face_order_sync/{orderId}`

`orderId, targetStatus ('delivered'), state (pending|completed|failed), attempts, lastAttemptAt, completedAt?, outcome? (delivered|already_delivered), lastErrorCategory? (protected_status|not_found|shop_mismatch|transient_external_failure|permanent_external_failure), createdAt, updatedAt`. No order contents, address, phone, payment, tokens or raw errors. **One record per order = one sync target per order** (explicit limitation): a second target would require changing the id to `orderId:target`.

The `pending` record is created **inside the same Firestore transaction** as the assignment's move to `delivered` (side write, created only if absent). So a crash after commit cannot lose the intent.

## 8. Retry behavior

No queue/worker platform. Bounded, in-process: up to 3 immediate attempts per run (backoff 500 ms, 2 s, never inside a transaction), 5 total attempts across runs. Transient failures leave `failed/transient_external_failure` (retryable); protected/not-found/shop-mismatch/permanent are final and never retried. A **startup sweep** (`retryOutstanding`, called from `server.ts`) re-attempts `pending` and retryable-`failed` records, and only if a `delivered` assignment exists for that order/shop. It runs once per boot; there is no scheduler, so a record that exhausts its attempts or stays failed while the server keeps running waits for the next restart or manual invocation. A future durable worker should replace this.

## 9. Idempotency

Deliver twice → the second is rejected by the state machine (409), no second side effect. A completed record short-circuits (`already_completed`). An order already `delivered` is recorded as success with no write. An ambiguous earlier failure followed by a retry sees `delivered` and records success without writing. `delivered → delivered` is never written.

## 10–12. Notifications: architecture, events, devices

`NotificationService` → `PushNotificationProvider` (interface) → `FcmPushNotificationProvider` (firebase-admin, same project as the Customer App) | `NoopPushNotificationProvider` (default; real sends only with `PUSH_NOTIFICATIONS_ENABLED=true`) | `InMemory…` (tests). The mobile apps never call FCM; they only register a token with the Duo-Face API.

Events: `delivery_assigned` (assignment created), `delivery_accepted`, `driver_picked_up`, `delivery_completed`. Payload `{type, orderId}` plus static copy. No GPS/location notifications exist.

Recipient = the Customer App order's `customerId` (customer's Firebase UID) → that user's **active** devices. Never a driver, merchant, phone number or address; the order must match the assignment's shop or nobody is notified.

Idempotency: one durable event per `${type}:${orderId}` in `duo_face_notification_events`, claimed transactionally before sending (stale `sending` claims expire after 2 min). Consequence: a *reassignment* after a rejection does not re-send `delivery_assigned`/`accepted` for the same order. A total provider failure records `failed` and a later trigger may retry; there is no notification retry worker.

Devices: `duo_face_notification_devices/{firebaseUid}:{deviceId}` `{deviceId, firebaseUid, platform (ios|android|web), pushToken, status (active|disabled), createdAt, updatedAt}`. The UID is embedded in the id so a chosen `deviceId` can never overwrite another user's device. Registration is idempotent and updates token/platform; a token re-registered by another account disables the previous holder's record. Invalid-token responses from FCM disable that device. `POST /customer/notifications/device` (Firebase token only, UID from the token, strict body, 20/min per UID) and `DELETE /customer/notifications/device/:deviceId` (own device only). Tokens are never returned or logged.

## 13. Privacy / security

Logs carry order/assignment ids and categories only — no tokens, addresses, phones, payment ids, full orders, coordinates or raw external errors. Sync and event records hold no PII. Customer endpoints authenticate a Firebase token and authorize by ownership (decision 023), not a Duo-Face role. Realtime/HTTP customer visibility rules are unchanged.

## 14. Fake vs real

Fake/mocked: Customer App order store, Firestore transaction (mock), sync/device/event stores, FCM provider, Firebase auth. **Not verified against real infrastructure:** any Customer App write, Firestore transactions and the atomic side write, FCM delivery (and whether the Customer App's FCM tokens work with this Admin project), device registration from a real client, the startup sweep against real data.

## 15. Changes needed outside this repository

1. The Customer App must call `POST /customer/notifications/device` (with its FCM token, a stable install id and platform) after sign-in and on token refresh, and `DELETE …/device/:deviceId` on sign-out.
2. It must handle notification `data.type` / `data.orderId` (deep link to the order).
3. Someone must set Customer App orders to `out_for_delivery` for the delivered-sync to ever write (see §3); Duo-Face deliberately does not.
4. Confirm no Customer App Cloud Function reacts to `status → delivered` in a way that conflicts (payment/settlement side effects).

## 16. Known production limitations

Startup-only sweep (no scheduler/worker); sync record has no per-attempt history; single sync target per order; notification duplicates suppressed per order/type (so reassignment is silent); at-most-once-ish pushes (a crash between claim and send loses one until the stale-claim window passes); per-instance state (rate limits) unchanged; concurrent duplicate sync runs on multiple instances could race on `attempts` (the order write itself stays safe); FCM/credentials/quota unverified; no delivery-receipt tracking; the sync is effectively inert until orders reach `out_for_delivery`.

## Phase 24A findings (source-level; see decision 025)

- The reviewed Customer App source has **no Firestore triggers** and never references `delivered`/`out_for_delivery`, so §5(a) "Cloud Functions reacting to status" resolves to *none exist in the reviewed source* (the backend is undeployed, so there is nothing live to inspect).
- **Nothing in the Customer App sets `out_for_delivery`**, so §3's prediction is confirmed at source level: the sync currently always yields `protected_status`. This is an external integration blocker, not a Duo-Face bug.
- The Firestore transaction and the real write remain **unverified against real Firestore** (no project or credentials were available in 24A).
