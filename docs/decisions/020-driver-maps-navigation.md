# 020 — Driver maps & navigation foundation

Status: implemented (Phase 19) — **configuration/bundle validated only; no map has been rendered and no GPS/device tested.**

## Map provider

`react-native-maps` (Expo-supported, pinned by `expo install` to the SDK-compatible 1.27.2). iOS uses Apple Maps (no key). Android uses the Google Maps SDK, which needs a key. No backend map proxy is involved; tiles load directly in the native SDK. It does **not** run on web, so `DeliveryMap.web.tsx` shows a notice there and the "Open in Maps" handoff still works. Expo Go or a development build can render it on a device; that has not been done here.

### Configuration

- `app.config.js` (dynamic layer over `app.json`) adds the `react-native-maps` config plugin and, if `GOOGLE_MAPS_ANDROID_API_KEY` is set at **build time**, writes it into the Android manifest.
- The key is not `EXPO_PUBLIC_*`, is not committed, and is documented in `app/.env.example`. Note that any Google Maps key ends up inside the built APK by design — restrict it in Google Cloud to this app's package name + signing SHA-1 and the Maps SDK for Android only.
- Without a key the map area may render blank on Android; the UI says so. iOS needs nothing.

## Destination coordinates

The Customer App stores a textual address only — **no lat/lng** (`docs/integration/CUSTOMER_APP_REQUIREMENTS.md`). Coordinates therefore cannot come from existing data, and none are invented.

- `DeliveryGeocoder` (`server/src/integrations/geocoding/DeliveryGeocoder.ts`) is the boundary; the only implementation is `UnconfiguredDeliveryGeocoder`, which returns `null`.
- `DeliveryOrderService` calls it **for the owning driver only** (never merchants, never a rejected/foreign assignment) and adds an optional `destination` to the delivery DTO if it returns valid coordinates. Failures, nulls and out-of-range values simply mean "no destination".
- Results are never written to the Customer App order, and nothing is cached or persisted in this phase. If caching becomes necessary (cost/latency), it should be a Duo-Face-owned collection keyed by assignment, designed then.

### Why no geocoding provider yet

Geocoding sends a customer's home address to a third party. That needs an explicit provider choice, a data-processing/privacy review, cost and quota decisions, and a key-handling plan. Using an undocumented/free public endpoint would leak PII with no agreement. So today every driver sees "Map location unavailable for this address" with the textual address; the map and Open in Maps become active the moment a geocoder is implemented — no UI change needed.

## External navigation

"Open in Maps" builds Google's documented universal Maps URL (`https://www.google.com/maps/dir/?api=1&destination=lat,lng`), which opens the installed Maps app on iOS/Android (and the website on web) without a key. It is built only from a valid destination; otherwise the driver gets a "Map location unavailable" message and no URL is created. No in-app turn-by-turn or routing.

## Driver location on the map

The section reads the driver's own latest location once (`GET /driver/location`, Phase 18) — no polling, timers, watchers, sockets or background tasks. Phase 18's server-computed `fresh`/`stale` flag is reused: only a **fresh** location is plotted; a stale one shows "Location stale — last updated X ago", none shows "unavailable" (with a note when permission is denied — read-only check, never a prompt). Failures show inline with Retry and never block the assignment screen.

## Access and privacy

Reachable only via the driver's own assignment (`/driver/assignments/:id/order`); rejected → 404, phone rules from decision 019 unchanged. No new location/order lookup routes (tests assert `/driver/location/:id`, `/driver/orders/:id` and merchant location routes are not routed). Driver GPS is not exposed to merchants, customers, other drivers or the Customer App; no location fields were added to merchant DTOs or Customer App orders.

## Why live tracking is deferred

Same reasons as decision 019 (cadence/battery, Redis GEO, sockets, background permission review, who may see what, retention) plus a geocoding/route-data provider decision. This phase only lays the map, destination boundary and hand-off.
