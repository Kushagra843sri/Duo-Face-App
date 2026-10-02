# 007 — Merchant shop boundary

## Status

Accepted 2026-09-28 (Phase 5, following `006-duo-face-identity-model.md`).

## Why Duo-Face owns merchant/shop ownership

Same evidence as `005`/`006`, unchanged by this phase: the Customer App's `shops/{shopId}` documents have no owner/admin field of any kind (`customer_app/lib/features/shops/models/shop.dart`), no merchant entity exists anywhere, and Firestore rules make `shops` public-read with no client writes at all. There was nothing to build a merchant/shop relationship on top of — it has to be a new, Duo-Face-owned concept, the same conclusion `005` already reached for identity itself.

## Why the Customer App's `shops` collection is not modified

Unchanged from every prior decision: `shops` is externally-owned/shared data (`001`, `002`). Adding an owner field to it, even additively, would mean Duo-Face's merchant feature depends on a write path into a collection the actual Allz Bharat app also reads — any bug or schema drift there risks the Customer App's own product catalog, for a relationship the Customer App has no concept of anyway.

## Does Duo-Face `shopId` correspond to a Customer App `shops/{id}`?

**No — not asserted, not assumed.** `duo_face_shops/{shopId}` is an independent, Duo-Face-generated identifier. Nothing in this phase links it to any real Allz Bharat `shops` document. A future phase *may* choose to let a Duo-Face shop reference a real Allz Bharat `shops/{id}` (e.g. so a merchant's Duo-Face shop can actually receive real customer orders, which live against `orders.shopId` pointing at the Customer App's own `shops` collection) — but that's an integration decision this phase deliberately does not make, since it would require deciding things Phase 5 is explicitly scoped to defer (how a merchant proves ownership of an existing Allz Bharat shop, whether Duo-Face's shop even needs to be the "same" entity, etc.).

## Current boundary

```text
Customer App (Allz Bharat):
  shops/{id}              — read-only from Duo-Face's perspective; never written

Duo-Face:
  duo_face_identities/{firebaseUid}  — role = merchant, merchant.shopId = X
  duo_face_shops/{X}                — merchantFirebaseUid = same firebaseUid
```

The two Duo-Face documents are created together, atomically, by `MerchantProvisioningService.provisionMerchantShop()` (`server/src/services/merchantProvisioningService.ts`) — a single Firestore transaction, not two separate writes. Reading either side alone and trusting it is exactly the "silently repair/guess" failure mode this project has avoided since Phase 3; `requireActiveMerchantShop` (`server/src/middleware/requireActiveMerchantShop.ts`) re-verifies the relationship on every request instead of trusting the identity's `shopId` blindly.

## Unresolved future integration requirements

- Whether a Duo-Face shop ever needs to reference a real Allz Bharat `shops/{id}` — and if so, who verifies that link (an onboarding flow checking the merchant actually operates that listed kirana store, presumably) — not designed.
- The actual merchant-provisioning *process* (who's authorized to call `provisionMerchantShop`, under what admin/ops flow) — still explicitly out of scope, same gap `006` already flagged for identity provisioning generally.
- Multiple shops per merchant, or multiple merchants per shop — this phase enforces one-to-one; revisiting that is a future product decision, not a technical limitation being worked around.
