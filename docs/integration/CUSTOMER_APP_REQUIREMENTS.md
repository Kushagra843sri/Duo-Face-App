# Customer App integration requirements

Client-facing checklist. This document exists so another engineering team (the Customer App's) can fill it in directly — every item below states what we need, why we need it, and an example of the *format* an answer could take. **No item has been answered.** Nothing here should be treated as confirmed until this document is updated with a real answer and a source (who confirmed it, and when).

See `docs/decisions/002-customer-app-integration.md` for how the codebase stays unblocked while these are outstanding, and `docs/integration/API_CONTRACT_TEMPLATE.md` for how confirmed endpoints/events should be documented once known.

---

## 1. Customer App Overview

- **Required information**: What the Customer App is, its current tech stack (backend language/framework, hosting), and who owns/operates it day to day.
- **Why Duo-Face needs it**: Everything else in this document depends on knowing what we're integrating with and who to ask follow-up questions.
- **Status**: UNKNOWN

## 2. Environment / Base URLs

- **Required information**: Base URL for each environment (dev/staging/prod) the Customer App's API is reachable at, and network access requirements (VPN, IP allowlist, public internet).
- **Why Duo-Face needs it**: The server needs a confirmed target to call before any integration code can be written.
- **Example format**: `https://api.customerapp.example/v1` (illustrative only — not a real URL)
- **Status**: UNKNOWN

## 3. Authentication

- **Required information**: Session-based or JWT-based auth? If JWT: issuer, signing algorithm, where the verification key/secret comes from. How is a token validated today (library, middleware)? Expiration and refresh behavior.
- **Why Duo-Face needs it**: `server/src/integrations/customerApp/CustomerAppAuthProvider.ts` defines a `verifyToken` capability with no implementation — this is what it needs to be implemented against. CLAUDE.md's rule that role is read from a server-verified JWT depends on knowing how the underlying identity is verified in the first place.
- **Example format**: "JWT, RS256, public key fetched from `/.well-known/jwks.json`, 1 hour expiry, refresh via `/auth/refresh`" (illustrative only)
- **Status**: UNKNOWN

## 4. User / Role Model

- **Required information**: What uniquely identifies a user (phone? email? internal ID?). Does a role/permission concept already exist in the Customer App, or is "merchant"/"driver" a Duo-Face-only concept layered on top? How is a user linked to a merchant/store or a driver identity?
- **Why Duo-Face needs it**: `server/src/integrations/customerApp/CustomerAppUserProvider.ts` has `getMerchantRelationship`/`getDriverRelationship` capabilities with `unknown` return shapes — this defines what they should actually return.
- **Status**: UNKNOWN

## 5. Merchant / Store Model

- **Required information**: Does a "store" or "merchant" entity already exist in the Customer App's data model? Fields, ownership (which user owns/manages a store), and whether Duo-Face is expected to add a new collection/table for merchant-specific data (per CLAUDE.md: "only add new fields or collections").
- **Why Duo-Face needs it**: Determines whether Duo-Face reads an existing store record or creates and owns its own.
- **Status**: UNKNOWN

## 6. Product / Inventory Model

- **Required information**: Product model (fields, variants, pricing, currency — CLAUDE.md requires integer paise, so we need to know if the Customer App already stores money as an integer or as a float/decimal). Stock model (per-item? per-variant? per-store?). Whether the existing backend supports an atomic stock decrement today, and how.
- **Why Duo-Face needs it**: `server/src/integrations/customerApp/CustomerAppInventoryProvider.ts` has `getProduct` (returns `unknown`) and `adjustStock` capabilities with no real shape or atomicity guarantee yet — checkout's last-unit race (CLAUDE.md's testing requirement) can't be implemented safely without this.
- **Status**: UNKNOWN

## 7. Order Model

- **Required information**: Full order lifecycle / status values. What determines order ownership (which merchant, which customer). How a delivery/driver gets linked to an order.
- **Why Duo-Face needs it**: `server/src/integrations/customerApp/CustomerAppOrderProvider.ts` has `updateOrderStatus` with a bare `status: string` — we need the real status enum and transition rules before `services/orderState`'s allowed-transition map (CLAUDE.md) can be written.
- **Status**: UNKNOWN

## 8. Delivery Model

- **Required information**: Does any delivery/driver concept already exist in the Customer App (e.g. a "rider" entity), or is this entirely new for Duo-Face? If it exists: how a driver is assigned to an order today, if at all.
- **Why Duo-Face needs it**: Determines whether Duo-Face's driver matching/dispatch logic (a later milestone) integrates with an existing concept or introduces a new one.
- **Status**: UNKNOWN

## 9. Realtime Events

- **Required information**: Does the Customer App already run Socket.IO, another WebSocket layer, or SSE? If yes: existing events, authentication for socket connections, room/channel structure.
- **Why Duo-Face needs it**: `CustomerAppOrderProvider.onOrderChanged` is optional precisely because this is unknown. Duo-Face must not run a second, conflicting realtime layer over the same order/inventory data.
- **Status**: UNKNOWN

## 10. Payment System

- **Required information**: Current gateway (Razorpay, Cashfree, or other — `SPEC.md.docx` lists this as unresolved, mentioning both). Payment lifecycle (authorization/capture/refund) as currently implemented. Webhook architecture and signature verification. Existing settlement/payout model, if any.
- **Why Duo-Face needs it**: No payment code exists in this repo yet (by design). This determines which gateway's SDK, if any, gets added in a later phase.
- **Status**: UNKNOWN

## 11. Firebase

- **Required information**: Does the Customer App already use a Firebase project? Is FCM already used for push — same project or a new one for Duo-Face? Is Firebase Phone Auth already the OTP mechanism, or a different SMS/OTP provider? Who owns the existing project (and can grant Duo-Face access)?
- **Why Duo-Face needs it**: Determines whether Duo-Face's OTP/push work (a later phase) shares a Firebase project or provisions a new one.
- **Status**: UNKNOWN

## 12. File / Object Storage

- **Required information**: Does the Customer App already use any object storage (for images, documents)? If Duo-Face's private R2 bucket for driver KYC documents (CLAUDE.md) needs to coexist with something the Customer App already has, what is it?
- **Why Duo-Face needs it**: Avoids provisioning storage that duplicates or conflicts with an existing setup.
- **Status**: UNKNOWN

## 13. Error Contract

- **Required information**: The existing API's error response shape/conventions (status codes, error body format) for endpoints Duo-Face will call or extend.
- **Why Duo-Face needs it**: `server/src/middleware/errorHandler.ts` currently defines Duo-Face's own error shape for its own routes; calls *into* the Customer App's API need to handle its actual error format, not Duo-Face's assumed one.
- **Status**: UNKNOWN

## 14. Rate Limits

- **Required information**: Any rate limits on the Customer App's existing API that Duo-Face's merchant/driver traffic would need to respect.
- **Why Duo-Face needs it**: Avoids Duo-Face's polling/sync patterns (if any are needed) accidentally tripping limits meant for the Customer App's own traffic.
- **Status**: UNKNOWN

## 15. Security Requirements

- **Required information**: Any existing security requirements Duo-Face must follow when touching shared data — e.g. field-level encryption, PII handling rules, audit logging expectations, IP allowlisting for new services.
- **Why Duo-Face needs it**: Determines constraints on the eventual `CustomerAppClient` adapter implementation beyond what CLAUDE.md already states for Duo-Face's own code.
- **Status**: UNKNOWN

## 16. Test / Staging Environment

- **Required information**: Is there a staging/sandbox environment of the Customer App's API and database that Duo-Face can develop and test against safely, without touching production data?
- **Why Duo-Face needs it**: Integration work (implementing the `customerApp` interfaces for real) cannot start against production data.
- **Status**: UNKNOWN

## 17. Required Credentials / Access

- **Required information**: Concrete list of credentials/access Duo-Face's team needs once integration starts — e.g. staging DB read/write credentials scoped to specific collections, an API key or service account for the existing backend, a Firebase project role, R2/S3 bucket access.
- **Why Duo-Face needs it**: Nothing here should be provisioned speculatively; this section exists to be filled in once Sections 2–12 are answered, as the concrete access list that follows from those answers.
- **Status**: UNKNOWN

## 18. Open Decisions

- **Required information**: Client confirmation on the two open architectural paths recorded in `docs/decisions/002-customer-app-integration.md` (Option A: extend the existing backend, vs. Option B: separate service behind a restricted integration mechanism) — this depends on answers to Sections 1, 2, 13, 15 and 17 above.
- **Why Duo-Face needs it**: Determines where the real `CustomerAppClient` adapter implementation lives and how it's deployed.
- **Status**: UNKNOWN

---

## Answering this checklist

Update the relevant section's **Status** to a real answer (with a source/date), not just "confirmed." Once a section is answered, the corresponding `server/src/integrations/customerApp/*` interface should be revisited in whichever phase implements it — interfaces should get more specific as real answers land, not before.
