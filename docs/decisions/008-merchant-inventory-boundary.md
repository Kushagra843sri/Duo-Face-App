# 008 — Merchant inventory boundary

## Status

Accepted 2026-09-28 (Phase 6, following `007-merchant-shop-boundary.md`).

## Customer App boundary — unchanged

`products/{productId}` and its `inStock: boolean` field are not touched by this phase, and never will be turned into a quantity (`003-inventory-and-financial-boundaries.md` already covered why: it's a shared document other systems read, and a boolean has no defined atomic-update path to inherit). `inStock` remains the Customer App's own availability signal for its own purposes.

## Duo-Face owns numeric inventory

`duo_face_inventory/{shopId}__{productId}` — a new, Duo-Face-owned collection. `productId` is stored as an opaque reference only; the full Customer App product document is never duplicated into it, and `FirestoreCustomerAppInventoryProvider.getProduct()` (the read-only existence check used at creation time) returns `unknown`, not a typed shape — this codebase still doesn't assume anything about the product document's fields beyond "it exists."

## `shopId + productId` uniqueness

The document ID is deterministically `${shopId}__${productId}` (`buildInventoryId()`, `server/src/types/inventoryItem.ts`) — one shop physically cannot have two inventory records for the same product, by construction, not by a uniqueness check that could race.

## Quantity / reservedQuantity semantics

Both are non-negative integers; `reservedQuantity` can never exceed `quantity` (enforced in the zod schema itself). `reservedQuantity` defaults to `0` and is **not settable by any route this phase** — no endpoint accepts it as input, matching the brief's "merchant cannot directly manipulate reservedQuantity." It exists purely as a boundary for a future order-reservation system to eventually claim against, without any reservation logic built yet.

## Transaction requirement

`setQuantity` and `adjustQuantity` both go through `InventoryStore.runTransaction()` (`server/src/integrations/firebase/FirestoreInventoryStore.ts`), whose real implementation performs the read, the business-rule check, and the write inside one Firestore transaction — never a `get()` followed by a separate `set()`. Concurrent adjustments to the same inventory record are Firestore's own transaction-retry problem to solve, not application code racing itself.

## Ownership / authorization boundary

Every inventory route resolves `shopId` from `req.shop.shopId` — the shop `requireActiveMerchantShop` already verified is active and actually owned by the authenticated `firebaseUid`. No route reads `shopId` from the request body, query string, or URL params; none of the six endpoints even have a `:shopId` segment, so there's nothing to override. Ownership tests in `server/tests/routes/merchantInventory.test.ts` construct two independent merchant/shop contexts and confirm neither can see or affect the other's inventory.

## Future order-reservation boundary (not built)

Nothing in this phase reserves stock against an order, decrements `reservedQuantity`, or connects to anything order-related — there is no order system yet. `reservedQuantity` is a placeholder invariant a future phase will actually populate and enforce; this phase only guarantees it can never silently exceed `quantity` or be set directly by a merchant request.
