# Duo-Face

One React Native (Expo) app with two interfaces — Merchant and Delivery Partner — chosen by the logged-in user's role. It's meant to plug into a client's existing Customer App database and API, but that integration is not built yet (see [Known integration blockers](#known-integration-blockers)).

Full spec: `docs/SPEC.md.docx`. Governing engineering rules: `CLAUDE.md`.

## Repository structure

```
app/       — Expo React Native app (Merchant + Driver interfaces)
server/    — Express API (TypeScript)
docs/      — spec, architecture decisions, integration requirements
```

See `app/README.md` and the sections below for how each part runs.

## Running the app

```bash
cd app
npm install
npx expo start
```

## Running the server

```bash
cd server
npm install
cp .env.example .env
npm run dev
```

`GET /health` should return `{ "status": "ok" }`.

## Running tests

```bash
cd server
npm test
```

## Current status: Phase 1 — foundation

This repository currently contains a project skeleton only:

- Expo app with placeholder `(merchant)` and `(driver)` route groups, NativeWind + Lucide configured, no real screens yet.
- Express server with `GET /health`, centralized error handling, zod-validated config, and an authentication middleware stub that always responds `501` (no real auth exists yet).
- The Customer App integration is defined as TypeScript interfaces only (`server/src/integrations/customerApp/`) — there is no database driver, no HTTP client, and no assumed schema.

Nothing here implements merchant/driver functionality, real authentication, inventory, orders, payments, or realtime — those are later milestones (M2 merchant → M3 driver → M4 launch, per `CLAUDE.md`).

## Known integration blockers

The Customer App's database engine, schema, API contract, authentication system, payment gateway, and Firebase usage are all unconfirmed by the client — `docs/SPEC.md.docx` itself lists most of these as open questions rather than settled facts. Full client-facing checklist: [`docs/integration/CUSTOMER_APP_REQUIREMENTS.md`](docs/integration/CUSTOMER_APP_REQUIREMENTS.md). Rationale and architectural decisions: [`docs/decisions/001-foundation.md`](docs/decisions/001-foundation.md), [`docs/decisions/002-customer-app-integration.md`](docs/decisions/002-customer-app-integration.md). Template for documenting confirmed endpoints/events: [`docs/integration/API_CONTRACT_TEMPLATE.md`](docs/integration/API_CONTRACT_TEMPLATE.md).
