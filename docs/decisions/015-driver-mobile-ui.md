# 015 — Driver mobile UI foundation

## Status

Accepted 2026-09-29 (Phase 14, following `012-merchant-mobile-architecture.md` and `014-delivery-assignment-lifecycle.md`).

## Driver route structure

```
app/(driver)/
  _layout.tsx        — the authorization gate + <Tabs> shell (Dashboard/Assignments)
  index.tsx           — Dashboard
  assignments/
    _layout.tsx          — <Stack> scoped to the Assignments tab (list -> detail)
    index.tsx             — Assignments list
    [assignmentId].tsx      — Assignment detail + lifecycle actions
```

The brief's suggested flat `assignments.tsx` + `assignments/[assignmentId].tsx` siblings hit the exact same Expo Router limitation `012` already documented for merchant Orders: a flat file and a same-named directory can't both resolve as one tab. The fix is identical to `012`'s — the list moved to `assignments/index.tsx` with its own nested `_layout.tsx` — applied here as a known, already-precedented adjustment rather than a new problem to solve.

`app/(driver)/_layout.tsx` and `app/(driver)/index.tsx` existed only as Phase-1 placeholder stubs (a bare `<Stack>` and a static "arrives in Phase 3" `EmptyState`) — this phase replaces both with the real gate and dashboard.

## Role-based routing

Unchanged from `012`: `app/app/index.tsx`'s `useRole()` → `GET /auth/me` decides the initial redirect (`merchant` → `/(merchant)`, `driver` → `/(driver)`, anything else → the existing unmapped `EmptyState`). No role-selection UI exists anywhere, and none was added — a user never chooses Merchant vs. Driver; the server's own `role` field does. Once inside a route group, that group's own gate (`GET /merchant/me` or `GET /driver/me`) is the authoritative check, exactly mirroring the merchant side — a stale or guessed client-side role can get you redirected toward a group, but never past its gate.

## API boundary

`app/api/driver.ts` wraps the existing `apiRequest<T>()` (`app/api/client.ts`) with `getDriverMe`, `getDriverAssignments`, `getDriverAssignment`, and the four lifecycle mutations (`acceptDriverAssignment`, `rejectDriverAssignment`, `pickupDriverAssignment`, `deliverDriverAssignment`) — same `ApiError`/`NetworkError` typing, same auth-header injection as every other API module. Nothing in `app/` imports a Firebase Admin or client Firestore SDK; the driver screens are exactly as REST-only as the merchant ones.

**One small backend DTO change**: `GET /driver/me` (`server/src/routes/driver/index.ts`) didn't include `phoneNumber` even though `DuoFaceDriver` has always had it — the brief's dashboard explicitly wants "driver phone if available." Adding it (conditionally, mirroring how `driverService.createDriver` already handles the optional field) was the one genuine DTO gap blocking the UI; nothing else needed a backend change, since `GET/POST /driver/assignments*` already returned every field the brief's screens display.

## Assignment lifecycle UI

Buttons are strictly gated on the fetched `status` — no dropdown/selector exists: `assigned` → Accept/Reject, `accepted` → Mark Picked Up, `picked_up` → Mark Delivered, `rejected`/`delivered` → no actions. This mirrors the state machine `014` already enforces server-side; the UI never offers a transition the backend would reject.

Every mutation follows the same non-optimistic pattern already established by `app/(merchant)/inventory.tsx`: a single `isMutating` flag (only one assignment is ever on-screen here, so no keyed map is needed, unlike inventory's per-row `mutatingProductId`) disables every button and shows an inline spinner to prevent duplicate taps; on success it calls `retry()` to refetch the real assignment from the server rather than guessing the new status locally; on failure it surfaces the server's own message via `Alert.alert(describeError(err).title, describeError(err).description)`. Reject and Deliver both require an `Alert.alert` confirmation first (Accept and Mark Picked Up do not, per the brief).

The detail screen shows no customer PII — the `DriverAssignment` DTO carries none (unlike the merchant order detail DTO, it has no delivery address/phone/payment fields), and the Customer App order is never fetched directly; only `/driver/assignments/:id` is read.

## Why GPS/maps/live tracking are deferred

Unchanged from `012`/`013`/`014`: this phase is strictly driver identity + assignment visibility + assignment lifecycle UI. GPS, location permissions, maps, route navigation, live tracking, WebSockets, background location, push notifications, earnings, payouts, KYC, and payment collection all require their own design decisions a future phase makes — none are needed for, or added by, this one.
