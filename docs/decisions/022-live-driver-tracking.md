# 022 — Live driver tracking backend foundation

Status: implemented (Phase 21) — **verified with fakes only. Real Redis, real Firebase, real GPS and on-device tracking were NOT exercised.**

## Firestore vs Redis boundary (CLAUDE.md: "Driver GPS goes to Redis GEO only, never to the DB per ping")

| | Firestore | Redis |
|---|---|---|
| Role | Durable **latest** snapshot (Phase 18) | Live tracking state / transport |
| Written | Manual `POST /driver/location`; plus **at most one snapshot per driver per 60 s** while tracking | Every accepted ping |
| Key | `duo_face_driver_locations/{driverId}` | see below |

`POST /driver/tracking/location` writes Redis. It writes Firestore only via the throttled snapshot (`DURABLE_SNAPSHOT_INTERVAL_MS`, 60 s, in-process, best-effort — a Firestore failure never fails a live update). Redis failure is **never** answered by writing the ping to Firestore. There is no background persistence worker.

## Redis model

```
duo_face:drivers:geo               GEO   member driverId, GEOADD longitude latitude
duo_face:drivers:seen              ZSET  member driverId, score = last update (epoch ms)
duo_face:drivers:location:<id>     HASH  latitude, longitude, capturedAt (epoch ms), assignmentId,
                                         [accuracyMeters, heading, speedMps]   + EXPIRE 300
```

- Key by `driverId` only (never a Firebase UID). No customer, order, address or payment data. `assignmentId` (opaque) is kept solely so a position published for one assignment is never served for another.
- GEO has no timestamp and its members cannot expire, so the HASH carries `capturedAt` and the TTL and is the **source of truth** for "is there a live location". `seen` lets each write prune GEO/seen members older than the TTL, so the GEO set can't fill with ghosts.
- One MULTI/EXEC per update: `DEL, HSET, EXPIRE, GEOADD, ZADD` (DEL first so optional fields from an earlier fix don't linger). `capturedAt` is the **server's** clock.
- GEO is written now (per CLAUDE.md, and for future nearest-driver queries) but **no radius query exists yet**.

## TTL vs freshness (explicitly different)

- **TTL 5 min**: after the last update the entry disappears (crashed/closed app). Long enough to survive brief signal loss and app switching.
- **Freshness 60 s** (`LIVE_LOCATION_STALE_AFTER_MS`): the one shared `getLocationFreshness()` function with the live threshold; the durable Phase 18 threshold (5 min) is the same function with a different argument. Computed on the server only — the mobile app displays, never recomputes. Between 60 s and 5 min a position is stored but "stale".
- iOS updates are distance-triggered, so a stationary driver can legitimately go "stale"; stale = not recently updated, not gone.

## Who may publish

`services/trackingPolicy.ts` (single definition): only `accepted` and `picked_up`. Not `assigned`, and never `delivered` / `rejected` / `cancelled`. Checking never changes assignment status.

Outcomes: other driver's / unknown / **rejected** assignment → 404; `assigned` / `delivered` / `cancelled` → 409; driver has **more than one** tracking-eligible assignment → 409 "ambiguous" (we never guess which gets the location; assignment creation semantics were not changed). Eligibility is read from the driver's own assignments and cached in-process for 15 s so a ~10 s cadence is not a Firestore read per ping; the read endpoint re-checks every time. Trade-off: after an assignment stops being eligible, a client may still publish for ≤ 15 s (a stale-cache window, accepted).

## Cadence (mobile, conservative)

Foreground watcher: `distanceInterval` 25 m, `timeInterval` 10 s (Android; iOS ignores it), plus a client throttle of ≥ 10 s between sends and skipping fixes with accuracy > 100 m ⇒ ≤ 6 updates/min. Balanced accuracy (not High) to save battery. No background location, no foreground service, no background task.

## Rate limit

12 requests / 60 s per driver (`TRACKING_RATE_LIMIT`): 2× the maximum client cadence, so retries/jitter pass while a runaway client is capped at 0.2 writes/s. Fixed window, in-memory, **per server instance** (N instances ⇒ up to N×12/min); applied after authentication so unauthenticated calls don't consume it; a Redis-backed limiter can replace it. 429 + `Retry-After`.

## APIs (Driver only)

- `POST /driver/tracking/location` — `{assignmentId, latitude, longitude, accuracyMeters?, heading?, speedMps?}` (strict; `driverId`/`firebaseUid` in the body → 400).
- `GET /driver/tracking/location/:assignmentId` — latest live position + `freshness`; 404 when none.
- `DELETE /driver/tracking/location` — best-effort "I stopped"; removes only the caller's own live entry; idempotent 204.

Guard: `authenticateFirebase → resolveRole → requireRole('driver') → requireActiveDriver`. No `:driverId` routes; no merchant/customer routes (tests assert they're unrouted).

## Failure behavior

Redis not configured (`REDIS_URL` unset), unreachable, timing out (2 s connect/command), or a command failing → `LiveLocationUnavailableError` → **503**, and the server keeps running (no offline queue, `maxRetriesPerRequest: 1`, error events handled). Logs carry driver/assignment ids and a category — never coordinates, the URL or Redis messages.

## Mobile

`lib/trackingController.ts` (`startTracking(assignmentId)`, `stopTracking()`, `isTracking()`): requires a signed-in user, fetches the assignment (server-enforced ownership), UI-hint status check, foreground permission (asks only on the Start tap), then `watchPositionAsync`. Stops on: Stop button, leaving the screen, app leaving the foreground, or a 401/403/404/409 from the server. 429 is skipped; 503/network errors are shown but tracking continues. UI: Start/Stop button, active/inactive, last update sent, error text.

## Privacy / security

Driver identity and assignment ownership are server-derived; no Firebase UID in Redis or responses; no merchant, customer or cross-driver access; the Customer App is untouched (no reads or writes in this phase). Deferred: customer/merchant tracking need a visibility policy (who, when, for how long, precision), consent/notice text and a delivery channel (sockets/push) that this phase deliberately doesn't build.

## Future: background tracking

Needs platform background permission and store review, an Android foreground service + notification, iOS background modes, battery/OS-kill behavior, and a heartbeat for stationary drivers. Scheduling and retry would move to a task, with the same server policy on top.

## Not verified

No Redis server was available: the real `ioredis` client path (connect, MULTI/EXEC, GEOADD, expiry, timeouts, reconnect, TLS) is untested; `RedisLiveDriverLocationStore` was exercised against a command-level fake that checks the command sequence, not Redis semantics. No device GPS, no permission prompts, no real Firestore snapshot, and no real Firebase auth were exercised.
