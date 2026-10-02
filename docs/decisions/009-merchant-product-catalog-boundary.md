# 009 — Merchant product catalog boundary

## Status

Accepted 2026-09-28 (Phase 7, following `008-merchant-inventory-boundary.md`). **The "real limitation" below is resolved as of Phase 8** — see the Update section.

## The actual Customer App products ↔ shops relationship

Confirmed directly from source (re-verified this phase, not assumed from memory): `products.shopId` is a real field on every product document, referencing the Customer App's own `shops/{shopId}` collection.

- `customer_app/lib/features/products/models/product.dart` — `final String shopId;`, read from and written to the Firestore document as `shopId`.
- `tools/seed_commerce/seed.js` — every seeded product carries `shopId: 'shop_001'` or `shopId: 'shop_002'`, matching the seeded shops' own document IDs.

This is a genuine, existing relationship — no field was invented to make this phase work.

## The real limitation: whose `shopId`?

The Customer App's `products.shopId` refers to a **Customer App** `shops/{id}` document (Customer-App-generated IDs like `shop_001`). Duo-Face's `duo_face_shops/{shopId}` uses an **independent, opaque** identifier (`007-merchant-shop-boundary.md` — explicitly not asserted to correspond to any real Allz Bharat shop). `MerchantProductCatalogService.listCatalog(shopId)` queries `products.where('shopId', '==', shopId)` using the merchant's **Duo-Face** shopId.

**This only returns real results if a Duo-Face shop's id happens to equal a real Allz Bharat shop's id.** Nothing in Phase 5's provisioning enforces or checks that today — `provisionMerchantShop` accepts any opaque `shopId` the caller supplies. This is not a bug introduced by this phase; it's the same open integration question `007` already flagged ("does a Duo-Face shop ever need to reference a real Allz Bharat `shops/{id}`") — Phase 7 is the first place that gap actually has a visible effect: a merchant's catalog is empty until/unless a future phase establishes that correspondence (e.g. an onboarding flow that requires claiming a real Allz Bharat shop ID as the Duo-Face `shopId`, or a separate cross-reference field). Documenting this rather than working around it (e.g. by inventing a new linking field) is the deliberate choice here.

## Update 2026-09-29 (Phase 8) — resolved via an explicit mapping field

`duo_face_shops.customerAppShopId` (optional) now carries the correspondence explicitly, instead of assuming `duoFaceShopId === customerAppShopId`. Neither identifier was renamed; no Customer App document was migrated.

- **Populated**: optionally, at provisioning time — `MerchantProvisioningService.provisionMerchantShop({ ..., customerAppShopId? })`. If supplied, it's verified against the real `shops/{id}` collection via the new `CustomerAppShopProvider.getShop()` (a minimal, read-only lookup — `id`/`name` only, not the full shop document) before being stored; a missing or malformed Customer App shop is rejected, never silently accepted.
- **`MerchantProductCatalogService.listCatalog(shop)`** now takes the full `DuoFaceShop`, queries products by `shop.customerAppShopId` (not `shop.shopId`), and returns `[]` immediately — without ever querying products — when `customerAppShopId` is unset. Duo-Face inventory continues to be keyed by the Duo-Face `shopId`, unaffected by this mapping.
- **Still unlinked shops**: `GET /merchant/products` returns an empty list, 200 — the same shape as "this shop genuinely has no products" — rather than a distinct error. Nothing yet exists to *set* `customerAppShopId` after initial provisioning (no "link an existing shop" flow); that remains a future phase's work, same as the provisioning-process gap `006`/`007` already flagged.

## What was implemented

`GET /merchant/products` — `authenticateFirebase → resolveRole → requireRole('merchant') → requireActiveMerchantShop`, then `MerchantProductCatalogService.listCatalog(req.shop)` (as of Phase 8, the full shop object — see Update below):
1. Reads Customer App products via the new, minimal `CustomerAppProductProvider.listProductsByShopId()` (read-only, one Firestore query, no writes).
2. Reads this shop's Duo-Face inventory via the existing `InventoryService.listInventory()` (Phase 6).
3. Joins them by `productId`, returning a safe DTO — never the raw Firestore documents.

A malformed Customer App product (missing name/price/inStock) is skipped and logged, not thrown — one bad product must not break a merchant's whole catalog view. This is different from how Duo-Face's own documents are treated (throw on malformed) precisely because Duo-Face doesn't control writes to `products`.

## DTO

```ts
{
  productId: string;
  name: string;
  price: number;      // as stored by the Customer App — still a float in rupees, per 003; not converted here
  inStock: boolean;    // Customer App's own signal, read-only
  inventory: { quantity: number; reservedQuantity: number; status: 'active' | 'disabled' } | null;
}
```

`inventory` is `null` when no Duo-Face inventory record exists yet — this endpoint never auto-creates one.

## Untouched

`products` and `inStock` are read-only from this endpoint's perspective — no write path exists anywhere in this phase. `categoryId`, `description`, `imageUrl`, `isActive`, `createdAt`, and the raw `shopId` are never included in the response.
