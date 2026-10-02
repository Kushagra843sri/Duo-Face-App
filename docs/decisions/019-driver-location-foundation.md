# 019 — Driver location foundation

Status: implemented (Phase 18) — backend tested; **GPS not tested on a device**.

## Part 1 — Delivery PII fix (from Phase 17)

`GET /driver/assignments/:id/order` now applies least privilege:

| Assignment status | Driver access | `delivery.phoneNumber` |
|---|---|---|
| `assigned` | yes | **withheld** |
| `accepted`, `picked_up` | yes | shown |
| `delivered` | yes (still the owner) | withheld (no operational need; access is not widened) |
| `rejected` | **404** | — |

Merchant behavior is unchanged (always includes the phone). `cancelled` has no producer yet; it behaves like `delivered` (readable, no phone). The phone rule lives in `DeliveryOrderService`, next to the ownership check.

## Latest-location-only model

`duo_face_driver_locations/{driverId}`: `driverId, latitude, longitude, accuracyMeters?, heading?, speedMps?, capturedAt, updatedAt`. The deterministic doc id means exactly one row per driver; each update **replaces** the document (no merge), so stale optional fields never linger. No history collection, no Firebase UID, order, customer, address or payment data.

- Validation (zod, shared by route and service): lat −90..90, lng −180..180, accuracy ≥ 0, heading 0..360, speed ≥ 0, all finite. The request schema is `.strict()`: a `driverId` (or any unknown key) is a 400.
- `capturedAt` is the **server's** clock (the device clock isn't trusted); `updatedAt` is a Firestore server timestamp.

## Authorization

`POST|GET /driver/location`: `authenticateFirebase → resolveRole → requireRole('driver') → requireActiveDriver → DriverLocationService`. 401 without/invalid token; 403 for merchants, unmapped identities and suspended drivers. The driver id is always `req.driver.driverId` — never a body field, never a URL segment (`/driver/location/:driverId` doesn't exist), never a Firebase UID.

## Privacy boundaries

Merchants get no access to driver GPS: no merchant location endpoint and no location field in any merchant delivery/driver DTO. Customers get none either. Exposing a location to anyone else needs its own decision (who, when, retention).

## Freshness

`getLocationFreshness(capturedAt, now, staleAfterMs = 5 min)` is pure → `'fresh' | 'stale'` (future timestamps count as fresh; missing/invalid as stale). `GET/POST` responses include it. The threshold is deliberately generous because updates are manual for now; it should tighten when live tracking exists. Nothing else is derived from it — no tracking state machine.

## Permission strategy (mobile)

`lib/locationService.ts` wraps `expo-location`: check permission (no prompt), request foreground permission, one-shot `getCurrentPositionAsync`, and a pure mapper to the API DTO (unavailable/negative heading & speed are omitted so the backend's validation isn't tripped). The Location tab only *reads* permission status on entry; the OS prompt appears only when the driver taps **Enable Location** or **Update Current Location**. The plugin config declares only a when-in-use string and explicitly disables iOS/Android background location and the foreground service.

## Why continuous/background tracking is deferred

It needs decisions this phase doesn't make: update cadence and battery budget, Redis GEO vs Firestore (CLAUDE.md says driver GPS never goes to the DB per ping), background permission review on both stores, Socket.io fan-out, who may see it and for which assignment states, and retention/history. Manual latest-location proves the storage, auth and permission plumbing first. No `watchPositionAsync`, background task, polling or timers exist in the app.

## Not tested

Backend behavior is covered by Jest with fake stores. On-device GPS, the OS permission prompts, `getCurrentPositionAsync` and the real Firestore write have **not** been exercised (no device, no Firebase project in this environment).
