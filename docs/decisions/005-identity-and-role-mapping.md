# 005 — Identity and role mapping

## Status

Accepted 2026-09-28 (Phase 3, following `002-customer-app-integration.md`). Documentation + minimal pipeline scaffolding — no merchant/driver resolution is actually implemented, by design. **Superseded in part by Phase 4** (see Update below): the pipeline now has a real, Duo-Face-owned resolver behind it. The evidence and conclusions below (Customer App has no role concept) are unchanged and remain the record of *why*.

## Update 2026-09-28 — Phase 4: final decision

> The Customer App does not contain an authoritative merchant or driver role mapping. Duo-Face therefore owns application-level role assignment in a dedicated Firestore collection.

`UnresolvedRoleResolver` (below) is no longer the production default — it's superseded by `DuoFaceRoleResolver`, backed by a new Duo-Face-owned `duo_face_identities` Firestore collection. Full model, ownership boundary, and security details: `docs/decisions/006-duo-face-identity-model.md`. The evidence for *why* this had to be Duo-Face-owned (not read from `users/{uid}` or `shops`) is exactly the reconnaissance below — nothing about that changed, only what was built on top of it.

## The actual Customer App identity model

Confirmed by direct source review (`Allz_Bharat_Final_Handover/source_code/`), not inferred from documentation:

- A user is identified purely by their Firebase Auth UID. `users/{uid}` — Firestore document ID *is* that UID directly.
- The only fields ever written to a user document: `uid`, `phoneNumber`, `name`, `displayName`, `createdAt` — written by `FirestoreUserRepository.createUserProfile()` in `customer_app/lib/features/auth/data/user_repository_impl.dart`.
- Cloud Functions never read or write the `users` collection at all (confirmed by grep across `functions/src`) — user profile management is entirely client-side, protected only by Firestore rules (`request.auth.uid == uid`).
- `setCustomUserClaims` is never called anywhere — no custom claim carries anything beyond what Firebase Auth itself manages (phone number, UID).

**There is no role concept anywhere in this system.** Full evidence table: `docs/integration/CUSTOMER_APP_REQUIREMENTS.md` §19.

## Merchant mapping: unsupported

`shops/{shopId}` documents have exactly these fields: `id, name, address, imageUrl, rating, isOpen, isActive, createdAt` (`customer_app/lib/features/shops/models/shop.dart`, cross-confirmed against `tools/seed_commerce/seed.js`'s actual writes). No `ownerId`, no `merchantId`, no field of any kind connecting a shop to a `firebaseUid`. Firestore rules make `shops` public-read and disallow all client writes — the only writer is the seed script's direct Admin SDK batch write. The only place `shops` is read server-side (`functions/src/handlers/createPaymentOrder.ts`) only ever accesses `.name`.

**Conclusion**: `firebaseUid → Merchant → Shop` is not supported by the existing Customer App today. There is nothing to resolve from.

## Driver mapping: unsupported

A repo-wide search for `driver`, `rider`, `deliveryPartner`/`delivery_partner`/"delivery partner" returns zero matches anywhere in the Flutter app or the Cloud Functions backend. `OrderDocument` (`functions/src/types/order.types.ts`) has no field referencing a driver. The handover documentation itself lists "Rider / Delivery Ecosystem" as "Not Started."

**Conclusion**: `firebaseUid → Driver` is not supported by the existing Customer App today — there is no driver identity concept to map into at all, not even a partial one.

## What was implemented

Given both mappings are confirmed absent (Case D, in the terms this phase was scoped with), the following pipeline exists but is honestly always unresolved:

```text
authenticateFirebase()  →  VerifiedFirebaseIdentity { firebaseUid }
        ↓
resolveRole(RoleResolver)  →  AuthenticatedPrincipal | 403
        ↓
requireRole(...)  →  still a 501 stub, unmounted (nothing to authorize against yet)
```

- `server/src/services/roleResolver.ts` — `UnresolvedRoleResolver`, a concrete implementation of `RoleResolver` whose `resolve()` always returns `null`. This is not a stand-in for missing code; it's the correct behavior given the evidence above.
- `server/src/middleware/resolveRole.ts` — new middleware distinguishing "identity is invalid" (401, `authenticateFirebase`'s job) from "identity is valid but has no application role" (403, this middleware's job).
- `GET /auth/me` now chains `authenticateFirebase → resolveRole`, so as of this phase it honestly returns 403 for every caller — that's the correct, evidence-based state of the system, not a bug to be fixed later without new information.

## What was deliberately not done

- No `merchants`, `drivers`, or `roles` collection was created. Guessing a schema here would be indistinguishable from the earlier MongoDB/paise/stock-quantity mistakes this project has already had to walk back.
- No `role`, `merchantId`, `shopId`-on-user, or `driverId` field was added to any existing or new Customer App document.
- No Firestore repository/client code was added to the resolver — `UnresolvedRoleResolver` doesn't touch Firestore, so there was nothing to build behind a repository boundary this phase.
- `AuthenticatedPrincipal.storeId` was **not** renamed to `shopId` in this phase — kept distinct from the Customer App's literal `shops` collection name pending a real mapping design. **Reversed in Phase 4** (`docs/decisions/006-duo-face-identity-model.md`): once an actual mapping existed to design, `shopId` won out as the field name, since that's what the real collection is called and the field appeared consistently that way across two consecutive phase briefs.

## Security boundary

Unchanged from Phase 2, now exercised end-to-end: no route trusts `role`, `shopId`, or `driverId` supplied by the client in a body, query string, or header (tested explicitly — see `server/tests/routes/auth.test.ts`). Authentication failures are `401`; a valid identity with no mapped role is `403` — these are now genuinely distinguishable, not just documented as a future intention.

## What a future phase needs before this can move past `UnresolvedRoleResolver`

- **Merchant**: a real decision (and implementation) for how a Duo-Face user becomes linked to a `shops/{shopId}` document — since the Customer App has nothing to read here, this is necessarily a **new** Duo-Face-owned relationship (a new field on `shops`, a new mapping collection, or an onboarding flow that writes one) — not something to discover by looking harder at the existing data.
- **Driver**: an entire driver identity concept designed from scratch — KYC, profile, availability — none of which exists in the Customer App to build on top of.
- Both require a real product/ops decision (who's allowed to claim ownership of a shop; how a driver applies and gets approved) that is out of scope for this phase and for source-code archaeology in general.
