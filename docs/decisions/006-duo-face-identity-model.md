# 006 — Duo-Face identity model

## Status

Accepted 2026-09-28 (Phase 4, following `005-identity-and-role-mapping.md`).

## Decision

The Customer App has no role concept at all (`005`). Duo-Face owns application-level role assignment in a dedicated Firestore collection:

```text
duo_face_identities/{firebaseUid}
```

## Ownership boundary

```text
Customer App (Allz Bharat) — externally owned, read-mostly:
  users, shops, products, categories, orders, payment_intents

Duo-Face — owned:
  duo_face_identities        (this phase)
  future driver profiles, delivery trips, wallet ledger,
  inventory quantity state   (later phases)
```

`duo_face_identities` is never read or written by the mobile app — only the Duo-Face server, via the Firebase Admin SDK (`server/src/integrations/firebase/FirestoreDuoFaceIdentityStore.ts`). No Customer App Firestore rule was touched.

## Document shape

```ts
{
  firebaseUid: string;
  role: 'merchant' | 'driver';
  status: 'active' | 'suspended';
  merchant?: { shopId: string };   // present, and only present, when role === 'merchant'
  driver?: { driverId: string };   // present, and only present, when role === 'driver'
  createdAt, updatedAt;
}
```

Validated by `server/src/types/duoFaceIdentity.ts` (a zod schema, matching this codebase's existing validation convention). Merchant and driver mappings are mutually exclusive; an active role without its corresponding id is rejected, not silently repaired.

`shopId`/`driverId` are opaque identifiers for now — per this phase's explicit constraint, no `shops`-ownership model or driver-profile collection is designed yet. A future phase decides what those ids actually point to and how; this document only establishes that an identity *carries* one.

## Supported roles and status

- `merchant` and `driver` only — matches `server/src/types/auth.ts`'s existing `Role` type, not duplicated.
- `active` / `suspended`. A suspended identity resolves to no principal (403), the same as an unmapped identity — distinguishable only in server-side logs, not in the client-facing response, since neither case should reveal more than "you're not authorized" to the caller.

## Provisioning is server-controlled

`DuoFaceIdentityService.provisionIdentity()` (`server/src/services/duoFaceIdentityService.ts`) is the only way to create an identity — and it is **not called from any route** in this phase. There is no `POST /auth/role`, no `POST /auth/register`, no self-service role selection of any kind. A mobile client cannot assign or change its own role, `shopId`, or `driverId` — `resolveRole` middleware only ever reads what the server-side resolver returns, never anything from the request body, query string, or headers (tested explicitly in `server/tests/routes/auth.test.ts`).

## Future requirement

A future phase must design the actual provisioning mechanism — who (what admin/ops identity, authenticated how) is allowed to call `provisionIdentity`, and under what process a shop owner or a driver applicant actually gets one. That security model doesn't exist yet and is explicitly out of scope here; `provisionIdentity` exists today only as the domain operation a future authenticated flow will call.

## `storeId` → `shopId` rename

`AuthenticatedPrincipal.storeId` (kept in Phase 3 as Duo-Face's own vocabulary, distinct from the Customer App's `shops` collection) is renamed to `shopId` in this phase. This phase's own brief showed the field as `shopId` in both the `AuthenticatedPrincipal` shape and the `/auth/me` response example — a second consistent signal after Phase 3's brief did the same — and the real collection is in fact called `shops`, not `stores`. CLAUDE.md's own "store" vocabulary (e.g. its realtime room naming) is untouched by this — that's a separate, later concern if it ever needs reconciling.
