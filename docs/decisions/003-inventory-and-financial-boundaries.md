# 003 — Inventory and financial boundaries

## Status

Accepted 2026-09-28 (Phase 1.75, following `002-customer-app-integration.md`). Documentation only — neither system described below is implemented yet.

## Context

Reviewing Allz Bharat's real source (`source_code/customer_app/lib/features/products/models/product.dart`, `source_code/tools/seed_commerce/seed.js`, `source_code/functions/src/services/pricing.service.ts`) confirmed two facts that CLAUDE.md's original rules didn't account for:

1. `products/{productId}` has a boolean `inStock`, not a numeric stock quantity — there is nothing to decrement.
2. `products.price` and `orders.pricing.*` are stored as JavaScript floats in rupees (e.g. `28`, `15.0`), not integer paise.

CLAUDE.md has been updated (Phase 1.75) to state the boundary rules directly. This record explains the reasoning behind them in more depth, for whoever designs the actual inventory and financial systems later.

## Inventory boundary

`Product.inStock` (existing, Allz Bharat-owned, boolean) and Duo-Face's future quantity-based inventory are **separate concepts** until a compatibility design is explicitly approved. Duo-Face does not read `inStock` as if it were a quantity, and does not write a `stock` field onto the existing `products` document as a shortcut.

**Why adding a `stock` field to the existing `products` document isn't automatically safe:**
- `products` is read by the Allz Bharat Flutter client and by `pricing.service.ts` today. A new field is additive and shouldn't break either — but a *quantity* field only means something if something also enforces it consistently. Setting `stock: 0` while `inStock: true` still says (silently, to the existing client) that the item is available; the two flags could drift and disagree with nothing to reconcile them.
- The existing `inStock` boolean has no defined update path (it's static seed data / presumably merchant-editable in a system that doesn't exist yet) — bolting a quantity onto it doesn't inherit any atomicity guarantee, because none exists for `inStock` today either.
- A real quantity model needs its own decisions this review deliberately didn't make: per-shop or per-variant, whether it lives on `products` itself or a separate collection, how it relates to `inStock` (derived from quantity? independently set?). Guessing any of that now would be exactly the kind of invented schema Phase 1/1.5 avoided for the Customer App's own data — the same discipline applies to a new field bolted onto their document.

**When quantity-based inventory is actually built**, it must use Firestore's transactional or atomic-increment mechanisms — a `runTransaction` read-check-write, or `FieldValue.increment()` on a dedicated numeric field — never read-then-write from application code. This mirrors CLAUDE.md's original intent (atomic checkout decrement, tested with two buyers racing for the last unit) — only the mechanism changes from Mongo's `findOneAndUpdate` to Firestore's transaction API.

Not implemented in this phase. No collection, field, or model is created here.

## Financial boundary

Existing Customer App monetary values (`products.price`, `orders.pricing.subtotal/deliveryFee/platformFee/total`) are stored as floats in rupees, rounded to two decimal places in application code (`Math.round(x * 100) / 100` in `pricing.service.ts`). Duo-Face does not change how Allz Bharat stores this data.

**Duo-Face-owned financial data** — any new wallet ledger, payout record, settlement record, or accounting representation Duo-Face introduces — uses integer minor units (paise) or another explicitly lossless representation. This was CLAUDE.md's original rule and remains unchanged for anything Duo-Face itself writes.

**At the integration boundary**, whenever Duo-Face reads a monetary value from an existing Allz Bharat document:
- The value's unit and representation (float rupees) is documented at the point of use, not assumed silently.
- Conversion to paise (if needed for a Duo-Face-owned calculation) happens explicitly — e.g. `Math.round(rupeeFloat * 100)` — at that one boundary point, not scattered across the codebase.
- No silent rounding: a conversion that would lose precision (fractional paise) is treated as a validation failure, not silently truncated.
- No financial arithmetic — sums, fee calculations, ledger entries — is performed in floats anywhere in Duo-Face's own code, even temporarily, even if the source value arrived as a float.

Not implemented in this phase. No conversion utility, currency type, or ledger schema is created here — this record states the rule the eventual implementation must follow.
