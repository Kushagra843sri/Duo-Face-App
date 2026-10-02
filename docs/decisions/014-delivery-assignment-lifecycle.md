# 014 — Delivery assignment lifecycle

## Status

Accepted 2026-09-29 (Phase 13, following `013-driver-and-delivery-assignment.md`).

## Why lifecycle state stays separate from the Customer App order status

Unchanged from `013`: `assigned/accepted/rejected/picked_up/delivered/cancelled` belong entirely to `duo_face_delivery_assignments/{assignmentId}` and are never written into the Customer App order's own `status` field. This phase makes that lifecycle real (drivers can actually move through it), which makes the boundary more important, not less — every mutation in this phase touches only the Duo-Face assignment document.

## State machine

```
assigned
 ├──> accepted ──> picked_up ──> delivered
 └──> rejected
```

`rejected`, `delivered`, and `cancelled` are terminal — nothing transitions out of them. `cancelled` also has no transition *into* it yet: no legitimate server-side trigger for cancellation exists (no merchant-initiated cancel flow, no ops mechanism), so `cancelAssignment` is intentionally not implemented this phase, per the brief's own instruction not to expose it without a real use case.

The whole table lives in one place, `server/src/services/deliveryAssignmentTransitions.ts` (`ALLOWED_TRANSITIONS`, `isValidTransition`, `TIMESTAMP_FIELD_BY_STATUS`) — every mutation, in every route, checks the transition through this single function. No route or service method scatters its own status comparison.

## Authorization model

- `POST /merchant/deliveries` derives `customerAppShopId` exclusively from `req.shop!.customerAppShopId` (via `DeliveryAssignmentService.requireLinkedCustomerAppShopId`, the same 409-on-unlinked check `GET /merchant/deliveries` already used). The request body schema (`{orderId, driverId}`) has no shop-id field at all, so a client-supplied one is structurally unreadable, not merely ignored.
- `GET /merchant/deliveries/:assignmentId` compares the assignment's `customerAppShopId` against the same server-resolved value; a mismatch returns 404 — a merchant can never learn that another shop's assignment exists.
- All four driver mutation routes (`POST /driver/assignments/:id/{accept,reject,pickup,deliver}`) authorize purely off `req.driver!.driverId` (attached by `requireActiveDriver`). No route reads a driver id from a body, query string, or route param for authorization — the `:assignmentId` param identifies *which* assignment, never *whose*. An assignment belonging to a different driver is treated as not found (404), matching the existing `GET /driver/assignments/:id` convention — ownership failures never distinguish themselves from "doesn't exist."

## Transaction / concurrency approach

Every mutation goes through `FirestoreDeliveryAssignmentStore.runTransaction(assignmentId, updater)` — the same shape as `FirestoreInventoryStore.runTransaction`, already established in Phase 6. The `updater` runs inside a single Firestore transaction: read current state, verify driver ownership, verify the transition via `isValidTransition`, then return the next document — `AppError` thrown inside the updater aborts the transaction and propagates unchanged. This means two concurrent driver actions on the same assignment can never both succeed: Firestore serializes the transaction, and whichever runs second re-reads the already-updated status and fails `isValidTransition`, producing a 409 rather than a corrupted or double-applied state. `assignDriver`'s own conflict check (`createIfNoActiveAssignmentForOrder`) is unchanged from `013` — still a transaction that reads only by `orderId` and rejects a conflicting active assignment before writing — now surfaced as `AppError(409, ...)` via a dedicated `ActiveAssignmentConflictError` the service catches, instead of a plain `Error` that would have produced a generic 500.

True Firestore contention isn't observable against the in-memory fake store used in tests; the tests instead verify the *logic* (calling the same transition twice in sequence, where the second call deterministically sees the first's already-applied result) rather than real concurrent execution. This is a known, stated limitation of testing without a live Firestore project — not a claim of having exercised real contention.

## Merchant assignment flow

`POST /merchant/deliveries` `{orderId, driverId}` → `DeliveryAssignmentService.assignDriver` (unchanged business logic from `013`, now reachable via a route and now throwing `AppError` instead of a plain `Error`): verifies the order exists and truly belongs to the merchant's own Customer App shop (collapsing "missing" and "wrong shop" into the same 404, per the same non-leaking rule `011` established for order detail), verifies the driver exists and is active, and atomically rejects a conflicting active assignment. Returns the created assignment as its DTO (`201`) — never a raw Firestore snapshot.

## Driver lifecycle

`POST /driver/assignments/:id/accept|reject|pickup|deliver`, no request body. Each calls the corresponding `DeliveryAssignmentService` method, which runs the shared `transitionAssignment` transaction: not-found or wrong-driver → 404; invalid transition (e.g. `assigned -> picked_up`, `accepted -> delivered`, anything from a terminal state) → 409; otherwise the assignment moves to the new status, the matching timestamp (`acceptedAt`/`rejectedAt`/`pickedUpAt`/`deliveredAt`) is set, `updatedAt` changes, and `createdAt`/`assignedAt` are left untouched.

## Explicit Customer App non-modification boundary

Nothing added this phase writes to the Customer App. `DeliveryAssignmentService` only ever calls `CustomerAppOrderProvider.getOrderById` (a read) — `updateOrderStatus` remains unimplemented (throws, per `013`) and is never called from any new code path. No order field, status, or document is ever touched; the assignment continues to reference `orderId`/`customerAppShopId` only, never copying or mutating the order itself.
