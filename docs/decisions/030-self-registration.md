# 030 — Self-registration (unified sign-up for merchants and drivers)

## Status
Accepted 2026-10-03. Supersedes the "no registration / no client-selected role" parts of 013 and 017.

## Decision
After phone sign-in, an account with no Duo-Face role (`GET /auth/me` -> 403) is offered "I run a shop" / "I deliver orders". The app sends that choice to `POST /auth/register`.

- The choice is a **registration intent only**. The server writes the role into `duo_face_identities` (one transaction with the shop/driver document, via the existing provisioning services) and every later request resolves the role from there. No route trusts a client-sent role; the CLAUDE.md rule is unchanged.
- Body is strict (`registerBodySchema`): `{intent:'driver', name}` or `{intent:'merchant', shopName}`. uid comes from the verified token; `driverId`/`shopId` are generated server-side; a client-sent uid/role/shopId/driverId is a 400.
- Create-only: an existing identity gives 409 and is never changed, so a role can't be switched by re-registering. One phone number = one role.
- Rate limited: 5 attempts/minute per verified uid.

## Merchants get a NEW shop
Registration creates a new Duo-Face shop with no `customerAppShopId` and no pickup location. Nobody can claim an existing Customer App shop (they have no owner field, so claiming would allow store takeover). Customer App orders/products only appear once a shop is linked, which needs a later admin or claim-code feature.

## Verification
New accounts start with `kycStatus: incomplete` (profile services); only an admin action sets `verified`. No admin tool exists yet, so nothing blocks unverified accounts today. A `REQUIRE_VERIFIED_KYC` gate (duty / order acceptance) is deliberately NOT part of this change and is still undecided.

## Dev preview
`EXPO_PUBLIC_UI_PREVIEW` is unchanged (dev-only sample data). To test both sides for real, sign in with two phone numbers (Firebase test numbers work).
