# 018 — Delivery order read boundary

Status: implemented (Phase 17)

## Assignment → order relationship

A Duo-Face `duo_face_delivery_assignments` document already holds `orderId`, `customerAppShopId`, `driverId`, status and lifecycle timestamps. That is the whole handoff model: **no Customer App data is copied into it** (no address, items, payment or totals). The order is read live from the Customer App when needed, so it can never go stale or diverge. No assignment fields were added.

## The read boundary

`DeliveryOrderService` (`server/src/services/deliveryOrderService.ts`) is the only way to get an order for delivery purposes:

- `getForDriver(driver, assignmentId)`
- `getForMerchantShop(shop, assignmentId)`

Both resolve the **assignment first**, check ownership, then call the shared `loadOrder`, which reads the order through the existing read-only `CustomerAppOrderProvider.getOrderById` (and `CustomerAppShopProvider.getShop` for the shop name). Merchant and Driver share this one code path.

Endpoints: `GET /driver/assignments/:assignmentId/order` and `GET /merchant/deliveries/:assignmentId/order`, behind the existing auth chains.

## Authorization

| Actor | Rule | Failure |
|---|---|---|
| Merchant | `assignment.customerAppShopId` == authenticated merchant's linked shop | 404 |
| Driver | `assignment.driverId` == authenticated driver's `driverId` | 404 |
| No/invalid token | | 401 |
| Wrong role | | 403 |

Inaccessible and non-existent assignments are indistinguishable (404). The order is reachable only through a valid assignment context.

## Why arbitrary order lookup is forbidden

`GET /driver/orders/:orderId` would let any driver read any customer's address and phone by guessing an ID. Assignment-scoped access ties every read to a business relationship (this driver was given this delivery). There is intentionally no such route.

## Safe delivery DTO

`{ assignmentId, orderId, shopName?, delivery: { label, fullAddress, phoneNumber }, items: [{ name, quantity }], itemCount, total }`.

Never exposed: `customerId`, payment ids/method/status, `productId`, per-item prices/subtotals, order status, Firestore metadata, any Firebase UID. `total` is the Customer App's float-rupee value, unchanged (decision 003). `shopName` is best-effort: if the shop can't be read the field is omitted, the request still succeeds.

## Consistency checks

- Order missing → 404 (assignment untouched, nothing created or repaired).
- `order.orderId != assignment.orderId` or `order.shopId != assignment.customerAppShopId` → treated as an integration inconsistency: the order is **not** returned, only assignment id is logged (no address/customer data), response is a generic 500. Nothing is auto-repaired.
- A structurally malformed order document fails schema validation (500), same as the merchant order detail.

## Customer App is read-only

Only `getOrderById` and `getShop` are ever called. `updateOrderStatus` is never invoked (asserted in tests with a provider whose write method throws). No Customer App schema, rules, screens or status are touched.

## Why status synchronization is deferred

Writing accepted / picked_up / delivered back to Customer App order `status` needs a confirmed, safe Customer App transition mechanism (see decision 011 — none exists; only `pending` and customer `cancelled` are ever written) and a mapping/idempotency design. This phase only establishes the verified read boundary a future sync can build on. Duo-Face assignment state remains independent.

## Related fix

Driver assignment endpoints now serialize timestamps as ISO strings (`toDriverAssignmentDto`). Previously they returned raw stored values, which for real Firestore Timestamps would serialize as `{_seconds,_nanoseconds}` and break the mobile date display.
