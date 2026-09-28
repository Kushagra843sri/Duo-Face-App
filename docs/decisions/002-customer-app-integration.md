# 002 — Customer App integration boundary

## Status

Accepted 2026-09-28 (Phase 1.5, following `001-foundation.md`). Updated 2026-09-28 same day after the Customer App's real source code (the "Allz Bharat" handover package) was reviewed — see **Update** below. The core decision is unchanged; several previously-unresolved items are now resolved, and the architecture choice between Option A/B has been made by the project owner.

## Decision

> Duo-Face will integrate with the existing Customer App through a controlled backend integration boundary. Direct mobile-to-database access is prohibited.

Concretely: the Duo-Face mobile app talks only to the Duo-Face server's own REST API. The Duo-Face server talks to the Customer App exclusively through the interfaces in `server/src/integrations/customerApp/` (`CustomerAppClient`, `CustomerAppAuthProvider`, `CustomerAppUserProvider`, `CustomerAppOrderProvider`, `CustomerAppInventoryProvider`). No component of Duo-Face holds a direct database connection to the Customer App's data today.

## Update 2026-09-28 — Customer App identified, source reviewed

The Customer App is **Allz Bharat**, a hyperlocal quick-commerce app. Its real source code (`Allz_Bharat_Final_Handover/source_code/` — Flutter client, Firebase Cloud Functions backend, Firestore rules, seed data) was reviewed directly, not just its handover documentation. Full findings: `docs/integration/CUSTOMER_APP_REQUIREMENTS.md`.

**Important context this review surfaced**: Allz Bharat is an *archived, undeployed* snapshot handed over zero-access — 0 live Cloud Functions, 0 live secrets, no existing Firebase project. There is currently no running Customer App backend anywhere. Whoever continues this project needs to stand up a fresh Firebase project before any integration is reachable over the network.

### Now resolved (previously unresolved)

- **Database engine**: Cloud Firestore (not Mongo, not Postgres — CLAUDE.md states MongoDB; see conflict below)
- **Authentication mechanism**: Firebase Authentication, Phone OTP sign-in; Cloud Functions callables receive a Firebase-verified `request.auth.uid`; no custom JWT issuer to integrate against
- **Order ownership**: `orders.customerId`, verified server-side; no merchant/driver ownership field exists yet (new, for Duo-Face to add)
- **Inventory ownership**: `products` collection exists with `inStock: boolean` — no stock *quantity* field exists at all; Duo-Face's atomic stock-decrement logic has nothing existing to build on
- **Realtime ownership**: confirmed absent — no Socket.IO/SSE/custom realtime layer in the backend
- **Payment gateway**: **Cashfree** (not Razorpay — resolves the `SPEC.md.docx` ambiguity), code complete but never run against live credentials
- **Firebase ownership**: no existing project; a new one must be created by the project owner

### Architecture decision (project owner, 2026-09-28)

Between the two options below, the project owner chose a variant of **Option B**: Duo-Face's server **stays Node.js + Express** (per CLAUDE.md) rather than becoming Cloud Functions itself. It reaches the Customer App's data by calling Firestore directly through the Firebase Admin SDK and/or invoking the existing callable functions (`createPaymentOrder`, `verifyPayment`) — not through a fully walled-off service with no direct data access, since Firestore doesn't offer Mongo/Postgres-style scoped DB users; access control has to be enforced in Duo-Face's own server code and Firestore security rules instead.

This is implemented behind the same `CustomerAppClient` interface boundary from `001-foundation.md` — no service code changes based on this choice, only the eventual adapter implementation.

### Still unresolved

- **Final role ownership / exact production auth integration**: whether Duo-Face maps an authenticated Customer App (Firebase) identity to merchant/driver authorization via its own JWT/session, via Firebase custom claims, or some other mechanism, remains an integration decision until the complete auth contract is confirmed — CLAUDE.md's "never trust a client-sent role" rule holds regardless of which way this goes.
- **Firestore ownership boundaries** (which fields/collections Duo-Face may add to vs. must never touch) — now documented in CLAUDE.md's Rules section as of this update, but the exact shape of new Duo-Face-owned collections is still undesigned.
- **Inventory quantity model** — that `inStock` (existing) and a future quantity model (Duo-Face-owned) are separate concepts is resolved; the quantity model's actual fields/collection are not designed yet (see `003-inventory-and-financial-boundaries.md`).
- Database ownership / long-term administration (who owns the new Firebase project's billing/IAM once created)
- Whether Duo-Face's server gets its own scoped service account or shares the one used for Allz Bharat's own Functions
- Storage ownership (no object storage observed in Allz Bharat; doesn't block Duo-Face's own R2 bucket either way)
- Rate limits (nothing found; likely N/A since nothing is deployed)
- Settlement/payout model (none exists in Allz Bharat; Duo-Face's own payout design is still open)

### CLAUDE.md conflicts — resolved 2026-09-28 (Phase 1.75)

These were real, confirmed contradictions between CLAUDE.md's stated facts and the actual Customer App. They've now been reconciled directly in `CLAUDE.md` (Stack, Architecture, and Rules sections) — kept here as the record of what was wrong and why:

1. **`DB: client's existing MongoDB`** — the real database is Cloud Firestore. Document-oriented like Mongo, but a different engine/API entirely (no aggregation pipeline, no `findOneAndUpdate`/`$gte`/`$inc` semantics — Firestore uses transactions or `FieldValue.increment()` instead). CLAUDE.md's Stack section now states Firestore + Admin SDK.
2. **`Money is stored as integer paise. Never use floats for money.`** — Allz Bharat's existing `products.price` and `orders.pricing.*` are stored as JavaScript floats in rupees (e.g. `28`, `15.0`). CLAUDE.md's Rules section now states a boundary rule: existing Customer App money stays float-as-is until read/converted explicitly at the integration boundary; any new Duo-Face-owned financial data still uses integer paise.
3. **`Stock decrement at checkout is a single atomic findOneAndUpdate with { stock: { $gte: qty } }`** — this was Mongo-specific syntax and also assumed a `stock` quantity field that doesn't exist in the real `products` schema (only a boolean `inStock`). CLAUDE.md's Rules section now states `inStock` is read-only from Duo-Face's side, and a real quantity model is new and separate, using Firestore transactions/`FieldValue.increment()` once built.

## Historical record — the original A/B framing

Kept for context on how the decision was reached.

### Option A — Extend the existing backend

Duo-Face's merchant/driver routes and services are added as modules inside (or alongside, sharing DB models with) the Customer App's existing backend.

### Option B — Separate service behind a restricted integration mechanism

Duo-Face runs as its own service, calling the Customer App only through documented APIs or a restricted, scoped access mechanism.

The chosen architecture (above) is closer to B in spirit — Duo-Face remains its own Express service — but doesn't have Option B's originally-envisioned restricted-DB-user isolation, since Firestore's access-control model doesn't offer that the way a SQL/Mongo scoped user would. That gap is intentional and tracked in "Still unresolved" above, not silently assumed away.
