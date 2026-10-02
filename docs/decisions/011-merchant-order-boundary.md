# 011 — Merchant order boundary

## Status

Accepted 2026-09-29 (Phase 9, following `009-merchant-product-catalog-boundary.md`).

## Actual Customer App order schema (confirmed from source)

`orders/{orderId}` (`functions/src/types/order.types.ts`): `customerId, shopId, shopName, items[] (productId, name, price, quantity, subtotal), delivery { addressId?, label, fullAddress, phoneNumber }, pricing { subtotal, deliveryFee, platformFee, total }, status, paymentStatus, paymentOrderId?, paymentId?, paymentMethod?, paidAt?, createdAt, cancelledAt?, cancellationReason?`. `orders.shopId` references the Customer App's own shop — same pattern as `products.shopId` (`009`).

The document ID itself is the order's identifier — `orderId` is not reliably present as a stored field (`OrderPromotionService.promoteIntentToOrder`'s written data omits it); this codebase always uses the Firestore doc ID.

## Actual fulfillment statuses

`OrderFulfillmentStatus = "pending" | "confirmed" | "preparing" | "ready_for_pickup" | "out_for_delivery" | "delivered" | "cancelled" | "rejected"` — but **only `pending` and `cancelled` are ever actually written anywhere in the codebase.** Confirmed by a repo-wide search: `confirmed`, `preparing`, `ready_for_pickup`, `out_for_delivery`, `delivered`, `rejected` appear nowhere outside this one type declaration — not in any handler, service, or the Flutter client.

## Actual status-transition mechanism: none

- `createPaymentOrder` → `payment_intents` draft (no order yet).
- `verifyPayment` / `cashfreeWebhook` → `OrderPromotionService.promoteIntentToOrder` → final `orders/{id}` document at `status: "pending"`. This is order *creation*, not a transition.
- Firestore rules allow the *customer* (not a merchant, not any server function) to flip `pending → cancelled` directly from the client, updating only `status`/`cancelledAt`/`cancellationReason`.
- **No Cloud Function, service, or any other code transitions an order between any of the other statuses.** There is nothing resembling a reusable "order state machine" to expose.

Per this phase's explicit instruction, no transition mechanism was invented. `PATCH /merchant/orders/:orderId/status` is **not implemented** — deferred until a real transition design exists (which will need real product decisions: who can confirm/reject an order, what "preparing → ready_for_pickup" actually requires, etc. — none of which are Duo-Face's to invent from source code alone).

## What was implemented

`server/src/integrations/customerApp/CustomerAppOrderProvider.ts` (interface, existing since Phase 1) gained `listOrdersByShopId` and a widened `getOrderById` (now `unknown`, matching the product/shop providers' pattern); `FirestoreCustomerAppOrderProvider` implements both for real. `updateOrderStatus` stays declared but throws — explicitly documenting the gap above rather than silently no-op'ing.

`MerchantOrderService` (`server/src/services/merchantOrderService.ts`) — same unlinked/broken-link boundary as `MerchantProductCatalogService` (409, kept as its own copy rather than refactoring that already-shipped service). `listOrders` skips malformed/mismatched documents (logged, not thrown — one bad order shouldn't break a list); `getOrder` throws on a malformed single document (a specific request for one resource shouldn't silently look like "not found").

**Routes**: `GET /merchant/orders` (list, safe summaries), `GET /merchant/orders/:orderId` (detail) — both behind `authenticateFirebase → resolveRole → requireRole('merchant') → requireActiveMerchantShop`, deriving the Customer App shop exclusively from `req.shop.customerAppShopId`. Cross-shop isolation: a detail request for another shop's order returns 404, not the data (proven in tests, including via a guessed valid order ID).

## Pagination — deferred, not invented

The Customer App's own confirmed composite index is `customerId + createdAt` (Phase 1.75 evidence) — a *different* one from what a `shopId + createdAt` ordered query would need. Rather than assume that composite index exists (and risk a runtime Firestore error demanding one be created), `listOrdersByShopId` uses only an equality filter (`where('shopId','==',shopId)`, index-free), and `MerchantOrderService` sorts newest-first in application code after validating each document. No cursor-based pagination is implemented — at the project's stated launch scale (~50 merchants, ~3,000 orders/month total), a single shop's order volume doesn't yet justify it, and building it against an unconfirmed index would be exactly the kind of guessing this project avoids.

## Safe DTOs

```ts
// list
{ orderId, status, itemCount, total, createdAt }
// detail (adds)
{ items[], delivery: { label, fullAddress, phoneNumber }, paymentStatus }
```
`customerId`, `paymentOrderId`, `paymentId`, `paymentMethod`, `paidAt`, `cancelledAt`, `cancellationReason` are never included.

## Untouched

No new Duo-Face order collection; no order state invented; no Customer App order document ever written by this phase; no Duo-Face inventory decrement (automatic or otherwise) triggered by any of this — inventory and orders remain entirely unconnected until a future phase deliberately designs that link.
