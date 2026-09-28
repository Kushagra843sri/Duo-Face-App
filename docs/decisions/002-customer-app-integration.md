# 002 — Customer App integration boundary

## Status

Accepted. Phase 1.5 (integration contract readiness review, following `001-foundation.md`).

## Decision

> Duo-Face will integrate with the existing Customer App through a controlled backend integration boundary. Direct mobile-to-database access is prohibited.

Concretely: the Duo-Face mobile app talks only to the Duo-Face server's own REST API. The Duo-Face server talks to the Customer App exclusively through the interfaces in `server/src/integrations/customerApp/` (`CustomerAppClient`, `CustomerAppAuthProvider`, `CustomerAppUserProvider`, `CustomerAppOrderProvider`, `CustomerAppInventoryProvider`). No component of Duo-Face holds a direct database connection to the Customer App's data today, and none should be added until the items below are resolved.

## Explicitly unresolved

The following are **not decided** and must not be assumed in code until the client confirms them (tracked in full, with required-information detail, in `docs/integration/CUSTOMER_APP_REQUIREMENTS.md`):

- Database engine
- Database ownership / access model (who can grant Duo-Face read/write, and to what)
- Existing backend ownership (who maintains it, can it be modified)
- API architecture (REST shape, versioning, base URLs)
- Authentication mechanism (session vs. JWT, issuer, validation)
- Role source of truth (does a role concept exist in the Customer App, or is it Duo-Face-only)
- Order ownership (which system is authoritative for order state)
- Inventory ownership (which system is authoritative for stock)
- Realtime ownership (does the Customer App already run a socket/SSE layer)
- Payment gateway (Razorpay, Cashfree, or other)
- Firebase ownership (existing project vs. new one)
- Storage ownership (existing object storage vs. Duo-Face's own R2 bucket)

## Open architectural options

Two integration shapes remain possible; **no choice is made here.**

### Option A — Extend the existing backend

Duo-Face's merchant/driver routes and services are added as modules inside (or alongside, sharing DB models with) the Customer App's existing Node.js backend. Inventory and order writes go through one shared service layer used by all three apps.

*Depends on*: the Customer App team allowing changes to their backend, and Duo-Face's team getting write access to that codebase.

### Option B — Separate service behind a restricted integration mechanism

Duo-Face runs as its own service with its own deployment, calling the Customer App only through documented APIs, or — if a shared database is unavoidable — through a restricted DB user scoped to specific collections/tables (no direct access to customer-facing tables Duo-Face doesn't own). The Customer App would then need some way to notify Duo-Face of relevant changes (webhook, change stream, or polling) if Option A's single-service consistency guarantee isn't available.

*Depends on*: the Customer App team being unable or unwilling to allow direct backend changes, and a documented API surface existing (or being built) for Duo-Face to call.

## Why this stays open

Choosing between A and B now would mean guessing at the Customer App's backend ownership, deployment model, and API maturity — none of which are confirmed (see `docs/integration/CUSTOMER_APP_REQUIREMENTS.md`, sections 1, 2, 17). The `CustomerAppClient` interface boundary (`001-foundation.md`) is designed so this choice, whichever way it goes, is implemented as a new adapter behind the same interface — no service code should need to change based on which option is picked.
