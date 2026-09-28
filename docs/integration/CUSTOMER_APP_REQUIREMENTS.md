# Customer App integration requirements

Checklist of information needed from the Customer App team before Duo-Face can implement any integration-dependent feature. Nothing here has been answered yet — `docs/SPEC.md.docx` lists most of these as open questions for the client, and no answer should be assumed or invented in code. See `docs/decisions/001-foundation.md` for how the codebase stays unblocked in the meantime (interfaces in `server/src/integrations/customerApp/`, no concrete DB/auth implementation).

## Database

- Engine: PostgreSQL or MongoDB?
- Hosting (provider, region, network access for a new service/module)?
- Full schema: collection/table names and fields for anything Duo-Face touches (users, stores, items/products, orders, drivers, payments)
- Relevant indexes on those collections/tables
- Transaction support available (needed for multi-document writes like checkout stock decrement)?
- What read/write permissions can a new module/service be granted — can it write directly, or only through the existing backend?

## API

- Base URL(s) for existing environments (dev/staging/prod)
- Authentication mechanism for calling the existing API
- Existing endpoints relevant to orders, inventory, users, stores
- Request/response schemas for those endpoints
- Error response format/conventions
- Rate limits

## Authentication

- Session or JWT? If JWT: issuer, signing algorithm, where the public key/secret is obtained
- How is a token validated today (library, middleware, shared secret)?
- User identity model: what uniquely identifies a user, and how is it linked to a merchant/store or a driver identity?
- Role model: does a role concept already exist, or does Duo-Face introduce it?
- Token expiration and refresh behavior

## Orders

- Full order lifecycle / status values
- What determines order ownership (which merchant, which customer)?
- How is a delivery/driver linked to an order?

## Inventory

- Product model (fields, variants, pricing)
- Stock model (per-item, per-variant, per-store?)
- Price model — currency, whether integer paise/cents already, tax handling
- Does the existing backend support atomic stock decrement today, and how?

## Realtime

- Does the Customer App already run Socket.IO, another WebSocket layer, or SSE?
- If yes: existing events, authentication for socket connections, room/channel structure — Duo-Face must not run a second, conflicting realtime layer on the same data.

## Payments

- Current gateway: Razorpay, Cashfree, or something else? (`SPEC.md.docx` lists this as unresolved — both are mentioned.)
- Payment lifecycle (authorization, capture, refund) as currently implemented
- Webhook architecture — endpoints, signature verification
- Settlement/payout model already in place, if any

## Firebase

- Does the Customer App already use a Firebase project?
- Is FCM already used for push notifications — same project or a new one for Duo-Face?
- Is Firebase Phone Auth already the OTP mechanism, or does the Customer App use a different SMS/OTP provider?
- Who owns the existing Firebase project (access for Duo-Face's build)?

## Answering this checklist

Answers should be added to this document (or linked from it) as they're confirmed, and the corresponding `server/src/integrations/customerApp/*` interface and `docs/decisions/` entry updated in the phase that implements it — not assumed ahead of time.
