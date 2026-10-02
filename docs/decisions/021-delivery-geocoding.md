# 021 — Delivery address geocoding & destination cache

Status: implemented (Phase 20) — **verified with fakes only; no request has been sent to the real provider.**

## Provider selection: OpenCage Geocoding API

Chosen on documented terms (checked against OpenCage's API docs/FAQ during this phase; **re-verify pricing and terms before purchase**):

| Question | Answer |
|---|---|
| Auth | API key as `key=` query parameter (their only method). Server-side only; the URL therefore must never be logged. |
| Storing results | Explicitly allowed: results "can be stored as long as you like", on any plan, even after cancelling. |
| Display requirement | None — results may be used on any map (our maps are Apple/Google + external Maps). |
| Provider retention | Queries are logged by default for ~6 months. We send `no_record=1`, which asks OpenCage not to keep a record of the query text (they still record that a request happened). Their privacy policy/DPA still needs a business review. |
| Rate limits | Free trial: 2,500 req/day, 1 req/s. Paid plans higher. 429 = rate limited, 402 = quota exceeded. The cache keeps volume to ≈ one call per distinct address. |
| Pricing | Free trial for development; production needs a paid subscription (flat monthly tiers). Not confirmed here. |
| Coverage/accuracy | India covered (OSM-based). Each result has `confidence` 1–10 (10 ≈ within 0.25 km, 9 ≈ 0.5 km, 8 ≈ 1 km, 7 ≈ 5 km). Indian street addresses often resolve only to locality level, so many addresses will yield "no destination". |

**Rejected:** Mapbox — its Geocoding terms require results be used with a Mapbox map (we use Apple/Google), and only its paid "permanent" mode allows storing. Google Geocoding — results must be shown on a Google map and caching is time-limited. The public Nominatim service — not intended for production app traffic.

## Privacy implications

A customer's delivery address is sent to a third party (OpenCage). Mitigations: only the **authorized driver of that assignment** can trigger it (after ownership and not-rejected checks); merchants never trigger it; `no_record=1`; only the address text is sent (no name, phone, order or ids); the mobile app never contacts the provider. Coordinates returned are cached in a Duo-Face-owned collection so each distinct address is sent **once**.

## Flow

```
GET /driver/assignments/:id/order
  -> auth chain (401/403) -> assignment owned by this driver, not rejected (else 404)
  -> Customer App order (read-only) + consistency checks
  -> DeliveryOrderService.resolveDestination(fullAddress)
       -> CachedDeliveryGeocoder
            normalize -> sha256 -> cache lookup
              hit (valid)   -> coordinates, no provider call
              miss          -> OpenCage -> validate -> cache (create-if-absent) -> coordinates
              any failure   -> null
  -> DTO with destination (only if resolved), never provider data
```

Mobile → Duo-Face API → geocoder. There is no `POST /geocode` or any endpoint that geocodes caller-supplied text (a test asserts these are unrouted).

## Normalization and hash

NFKC → lower-case → every run of non-(letter | combining mark | digit) becomes one space → trim. E.g. `12/A, MG Road,  Delhi.` → `12 a mg road delhi`. Order and tokens are preserved (no fuzzy matching: a wrong hit would misdirect a driver). Non-Latin scripts survive (a test guards Devanagari — combining marks are kept). The provider receives the trimmed **original** address (better results), not the normalized form.

Hash = SHA-256 hex of the normalized address = the document id. The raw address is never an id. It is unsalted, so it is a stable key, not anonymization; `normalizedAddress` is stored alongside it (needed to verify a hit) — the collection therefore contains addresses and should be treated as PII with the same access controls as orders.

## Cache: `duo_face_delivery_destinations/{addressHash}`

`destinationId, addressHash, normalizedAddress, latitude, longitude, provider, precision (OpenCage confidence), createdAt, updatedAt`. No customerId, phone, payment, Firebase UID, driverId, assignmentId or order data. No expiry (storage is permitted and addresses rarely move); a manual delete forces a re-geocode.

- A valid hit is never re-fetched or overwritten. A hit must also match `addressHash` and `normalizedAddress`.
- A malformed document is never exposed; the service re-geocodes and repairs it via `replace` (the only overwrite path).
- Creation uses Firestore `create()` (atomic; fails if it exists), so duplicate documents and overwrites of a good one are impossible. Concurrent lookups of the same address in one process share one in-flight promise. **Across server instances, two simultaneous first-ever requests can still each call the provider (a rare duplicate call); only one document results.**

## Coordinate validation

Finite numbers, lat −90..90, lng −180..180, and confidence ≥ `GEOCODER_MIN_CONFIDENCE` (default 7). Anything else is a failure: not cached, not returned. Cached documents are re-validated on read.

## Failure behavior

Categories: unavailable (network/5xx), timeout (default 5 s), rate_limited (429/402), auth (401/403 — ops problem), invalid_address (400), no_result, low_confidence, malformed, invalid_coordinates, plus unconfigured. All yield `destination` absent; the delivery order is **still returned**. Failures are never cached (a transient outage doesn't poison an address). Logs contain the address hash and category only — never the address, URL (key), or provider body; errors carry a category only.

## Configuration

`OPENCAGE_API_KEY` (server `.env`, gitignored; empty ⇒ geocoding off), optional `GEOCODER_COUNTRY_CODE`, `GEOCODER_MIN_CONFIDENCE`, `GEOCODER_TIMEOUT_MS`. Without a key the app behaves exactly as in Phase 19 ("Map location unavailable"). A malformed optional setting also turns geocoding safely off. Nothing is added to the mobile bundle.

## Ownership

Only the assigned driver (assignment `driverId` == authenticated driver, status ≠ rejected) can trigger geocoding. Merchant delivery-order retrieval never geocodes and never carries coordinates. Nothing is written to Customer App data; the Customer App is untouched.

## Why live tracking is still deferred

Unchanged from 019/020: cadence and battery, Redis GEO, sockets, background permissions, visibility rules, retention. This phase only resolves a *static destination*.

## Not verified

No real OpenCage request was made (no key here), so actual response shapes, quota behavior, India accuracy/hit-rate and the `no_record` behavior are unconfirmed against the live service. The response parser follows OpenCage's documented shape (`results[].geometry.{lat,lng}`, `confidence`, HTTP status codes). Real Firestore `create()` conflict handling (gRPC code 6) is also untested without a project. The map still has not been rendered on a device.
