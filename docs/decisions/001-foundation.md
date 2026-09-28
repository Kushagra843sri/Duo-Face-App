# 001 — Project foundation

## Status

Accepted. Phase 1 of the build (see `CLAUDE.md` milestone order: M1 → M2 → M3 → M4).

## Context

Phase 0 reconnaissance of this repository found only `CLAUDE.md` and `docs/SPEC.md.docx` — no application code, no server, no Git history, and no access to the Customer App's backend, database, or auth system. `SPEC.md.docx` itself treats the database engine (Postgres vs. MongoDB), the payment gateway (Razorpay vs. Cashfree), and several other integration facts as **open questions for the client**, not settled decisions. `CLAUDE.md` states some of these as fact (e.g. "client's existing MongoDB"); until the client confirms them, this codebase treats them as unknown.

Phase 1's job is to scaffold a foundation that later phases (M2 merchant, M3 driver, M4 launch) can build on, without baking in any assumption about the Customer App that hasn't been confirmed.

## Decisions

**One mobile app, role-based routing.** A single Expo/React Native app mounts either the Merchant stack or the Driver stack based on the logged-in user's role, per `CLAUDE.md`. This avoids maintaining two separate app builds for what is, structurally, the same client talking to the same API.

**Mobile never talks to the database directly.** Every write goes through the server's REST API (`CLAUDE.md` rule). This is the mechanism that keeps inventory, orders and driver state consistent across the Customer App, Merchant interface and Driver interface — three writers on the same data would otherwise race.

**The Customer App integration sits behind an adapter boundary.** `server/src/integrations/customerApp/` defines TypeScript interfaces (`CustomerAppClient`, `CustomerAppAuthProvider`, `CustomerAppOrderProvider`, `CustomerAppInventoryProvider`, `CustomerAppUserProvider`) describing the capabilities Duo-Face needs from the Customer App, with no concrete implementation. Services depend on these interfaces, never on a specific driver or HTTP client. This means the eventual choice of "extend the existing backend" vs. "separate service with a restricted DB user" (both floated in `SPEC.md.docx`) doesn't require touching any service code — only a new adapter behind the same interface.

**Database choice is intentionally unresolved.** No MongoDB or PostgreSQL driver is installed, and no repository implementation exists. Writing one now would mean guessing at collection/table names and query patterns for a schema nobody here has seen — `docs/schema.md`, which `CLAUDE.md` cites as the source of truth for collections and fields, does not exist in this repository.

**Authentication implementation is intentionally unresolved.** `server/src/middleware/auth.ts` fixes the shape (`requireRole()` guarding a route, reading a role off a verified principal) without implementing it — it always responds `501` — because the Customer App's JWT issuer, signing method, and claims shape are unconfirmed. This preserves the `CLAUDE.md` rule "role is read from the JWT on the server, never trusted from the client" as an architectural constraint on whatever gets built in Phase 2, rather than as an assumption we invented now.

## Current architecture

```
app/ (Expo + Expo Router)
  app/(merchant)/, app/(driver)/   — placeholder route groups
  components/, api/, hooks/, lib/, types/, constants/, socket/ (reserved)
       │
       ▼  REST only
server/ (Express + TypeScript)
  routes/{auth,merchant,driver}/  — empty, nothing mounted yet
  middleware/  — error handling, 404, auth stub (501)
  integrations/customerApp/  — interfaces only, no implementation
  services/, repositories/  — empty, waiting on confirmed DB + auth
       │
       ▼  UNKNOWN
Customer App (external, not in this repo)
```

The only working endpoint is `GET /health`.

## Known blockers

Tracked in full in `docs/integration/CUSTOMER_APP_REQUIREMENTS.md`. In short: the Customer App's database engine and schema, its API contract, its auth mechanism, its order/inventory model, its realtime layer (if any), its payment gateway, and its Firebase usage are all unconfirmed. No feature that depends on any of these can move past its current interface/stub until the client answers.
