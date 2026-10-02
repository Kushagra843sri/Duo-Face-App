# 012 — Merchant mobile architecture

## Status

Accepted 2026-09-29 (Phase 10, following `011-merchant-order-boundary.md`).

## Mobile → backend boundary

The app talks to the Duo-Face server over REST only, via a single `apiRequest()` (`app/api/client.ts`) — every call goes through it, no screen calls `fetch()` directly. It never touches Firestore, and never will: nothing in `app/` imports a Firebase Admin or client Firestore SDK, and none is a dependency.

## Backend is the sole authorization authority

`app/app/(merchant)/_layout.tsx` is the only gate into the merchant route group, and it gates by calling `GET /merchant/me` — which runs `authenticateFirebase → resolveRole → requireRole('merchant') → requireActiveMerchantShop` server-side. No local role variable, cached value, or client-side guess is trusted; a 401/403/409 from that one call is rendered in place (via `ErrorState`) rather than papered over. `app/hooks/useRole.ts` (used by the root `app/index.tsx` to decide the initial merchant/driver redirect) is the same principle at the lighter `/auth/me` layer.

## Route structure

```
app/(merchant)/
  _layout.tsx        — the authorization gate + <Tabs> shell (Dashboard/Products/Inventory/Orders)
  index.tsx           — Dashboard
  products.tsx         — Products (flat tab)
  inventory.tsx         — Inventory (flat tab)
  orders/
    _layout.tsx          — <Stack> scoped to the Orders tab (list -> detail)
    index.tsx             — Orders list
    [orderId].tsx           — Order detail
```

Adjusted from the brief's suggested flat `orders.tsx` + `orders/[orderId].tsx` siblings — Expo Router can't cleanly route a flat file and a same-named directory as one tab, so the list moved to `orders/index.tsx` with its own nested `_layout.tsx` for the list→detail push. `<Tabs>`/`<Stack>` are both from `expo-router`, already a dependency — no new navigation library.

## API client

`app/api/client.ts`'s `apiRequest<T>()` centralizes: the base URL (`lib/env.ts`), the `Authorization` header (`authService.getIdToken()` — never invented, `null` when unset), safe JSON parsing, and two typed errors instead of a bare `Error` — `ApiError` (`status`, `code?`, `message`, for any non-2xx response) and `NetworkError` (for a `fetch()` failure itself). `app/api/auth.ts` and `app/api/merchant.ts` wrap it with typed functions and DTOs matching the server's actual response shapes exactly. `app/hooks/useApiResource.ts` is the one shared loading/error/retry implementation every screen uses — no screen reimplements that logic, and none scatters raw `fetch()` calls.

## Authentication boundary

`AuthService` (`app/lib/authService.ts`, unchanged since Phase 2) stays exactly as it was — still `UnconfiguredAuthService`, `getIdToken()` still returns `null`. This phase doesn't touch it: real Firebase Phone Auth remains a future phase's work (decision `002`). The whole app is architecturally ready for a real token the moment that lands — `apiRequest()` already reads `authService.getIdToken()`, it just currently always gets `null`, which correctly produces 401s from every protected endpoint (verified live — see Validation).

## Why Firestore is never accessed directly

Unchanged from every prior phase's boundary (`001`, `002`, and every merchant-feature decision since): the mobile app is not a trusted client for Firestore security-rule purposes the way the Customer App's own Flutter client is, and Duo-Face's authorization model (role resolution, shop linkage, ownership) lives entirely server-side. Giving the app a Firestore SDK would bypass all of it.

## Current read-only scope

Products and Orders remain read-only: both display the server's DTOs with zero edit/mutate affordances (Orders has no status transition buttons because no such mechanism exists server-side either, per `011`). The Orders list DTO doesn't include `paymentStatus` (only the detail DTO does) — the brief's item 9 asked for both list columns and "use the actual backend DTO"; the real DTO won, `paymentStatus` shows only on the detail screen.

**Inventory is no longer read-only as of Phase 11.** The Phase 6 backend (`/merchant/inventory` create/quantity/adjust/disable) already had full validation and error semantics — no backend change was needed. The mobile screen adds create (reached from Products, for a product with no inventory record yet), edit-quantity (modal), adjust by a signed delta (+/- buttons around an amount input), and disable (confirmed via `Alert.alert`). Every mutation is non-optimistic: the UI never predicts the result locally (in particular it can't know `reservedQuantity`-driven validation outcomes ahead of the server), so on success it always refetches the list via the existing `retry()` from `useApiResource` rather than patching local state. A single `mutatingProductId` tracks which row is in flight, disabling that row's controls and showing an inline spinner to prevent double-submission; mutation failures surface via `Alert.alert` using the same `describeError()` mapping the rest of the app uses (now including a 400 → "Invalid input" case), not a full-screen `ErrorState`, since the list underneath is still valid.

## No app-side test framework yet

Confirmed (again) that `app/package.json` has no `jest`/testing-library of any kind — same state as Phase 1's original decision. Per "do not introduce a new testing framework," none was added this phase either. The new pure logic (`describeError()` in `app/components/ErrorState.tsx`) is written as a plain, exported function specifically so it's trivial to test the moment a framework is chosen — not silently skipped, just deferred to that decision.
