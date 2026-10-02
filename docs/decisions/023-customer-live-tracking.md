# 023 — Customer live delivery tracking

Status: backend + realtime contract implemented (Phase 22). **No Customer App UI exists in this repo; real Customer Firebase auth, real Redis, and Redis-adapter fan-out were NOT tested.** A real WebSocket connection *was* exercised locally (in-process server + `socket.io-client`, fake token verifier).

## Architecture

```
Driver App -> POST /driver/tracking/location -> Redis live location (state)
                                     \-> DeliveryEventHub -> Socket.IO gateway -> Customer App
Customer App -> GET /customer/orders/:orderId/tracking   (snapshot)
Customer App -> Socket.IO  subscribe {orderId}           (realtime)
```

The Customer App never touches Redis or Firestore for this; it talks only to the Duo-Face API/gateway. Live-location **state** (`LiveDriverLocationStore`, Redis GEO — unchanged, no second store) is separate from event **transport** (`DeliveryEventHub` in-process hand-off → Socket.IO). Events are announcements; the store remains the source of truth.

## Customer authorization

Customers are Customer App Firebase phone-auth users; Duo-Face has **no customer role** and none was added to `duo_face_identities`. The customer endpoints run `authenticateFirebase` only (not `resolveRole`). The one authoritative check is:

`order.customerId (read-only from the Customer App order) === verified Firebase UID`

Missing order, someone else's order, an order whose stored id doesn't match, and an order without a `customerId` all return the same 404. A merchant or driver identity is treated like any other user: for an order they don't own → 404 (they are not blocked from their *own* customer orders, since one phone number can be both). Nothing about customerId/driverId is read from the request.

Assignment resolution: `DeliveryAssignmentService.getCurrentForOrder(orderId, order.shopId)` — active assignment first, else most recent; only assignments whose `customerAppShopId` equals the order's shop count. New store method `listByOrderId` (single-field equality).

## Tracking availability & DTO

Live location is exposed only when the assignment is `accepted` or `picked_up` (the same `isTrackingEligible` policy as the driver side), **and** a Redis position exists, **and** `position.assignmentId == resolved assignmentId` (a previous assignment's position is never shown).

```json
{ "tracking": { "available": true, "status": "accepted|picked_up|assigned|pending|delivered|cancelled",
    "location": { "latitude": 0, "longitude": 0, "capturedAt": "ISO", "fresh": true },
    "destination": { "latitude": 0, "longitude": 0 }, "updatedAt": "ISO" } }
```

`location`/`destination` are omitted when unavailable. Customer-facing `status`: no assignment or `rejected` → `pending` (the customer is not told drivers declined); `assigned` → "waiting for driver" with **no coordinates**. Not exposed: driver name (conservative: no product requirement yet), driver/assignment/internal ids, Firebase UIDs, phone, accuracy/heading/speed, Redis keys, address text, payment data.

`destination` comes from the existing cached server-side geocoding boundary (decision 021), only in tracking-eligible states, for the customer's own address; the mobile app never contacts a geocoder.

**Freshness:** the shared `getLocationFreshness` with the live 60 s threshold → `fresh`. A stale position (up to the 5-min Redis TTL) is *returned* but marked `fresh:false` — the contract explicitly permits stale display; clients must not present it as live. Redis unavailable → the read view degrades to `available:false` (200), not an error.

## Realtime (Socket.IO over WebSocket)

- **Handshake:** `io(url, { auth: { token: <Firebase ID token> } })` — never a query string. Failure → `connect_error` message `unauthorized` (no verifier details) or `rate_limited`.
- **Subscribe:** client emits `subscribe {orderId}` with an ack. The server verifies ownership, resolves the assignment and eligibility (the same `getSnapshot`), and only then joins the internal room `delivery:<orderId>` (clients can't name rooms; there is no driver room). Ack: `{ok:true}` or `{ok:false,error:'not_found'|'invalid'|'rate_limited'|'too_many'|'unavailable'}`. Foreign/missing orders are both `not_found`.
- **Initial state:** immediately after a successful subscribe the server emits `tracking` `{type:'snapshot', tracking}` — the current Redis location, so there is no blank map. If none exists → `available:false`; nothing is manufactured. Subscribing while `assigned`/`pending` is allowed (the customer then receives later events); for `delivered`/`cancelled` the server sends the snapshot and `tracking_ended` and keeps no subscription.
- **Events** (one channel, `tracking`):
  - `{type:'driver_location', location:{latitude, longitude, capturedAt}}` — exactly these fields.
  - `{type:'delivery_status', status:'pending|assigned|accepted|picked_up|delivered|cancelled'}` — from Duo-Face assignment transitions only (the Customer App order is never modified).
  - `{type:'snapshot', tracking}` and `{type:'tracking_ended'}`.
- **Delivered/cancelled:** the status event is followed by `tracking_ended` and all sockets are removed from the room; no further location is delivered.
- **Disconnect:** Socket.IO drops the socket and its rooms. It does not touch driver tracking, the assignment, or the Customer App order.
- `unsubscribe {orderId}` leaves the room.

Known small gap: an event published between computing the snapshot and joining the room can be missed; the next location ping (≤ ~10 s) supersedes it.

## Abuse protection (per server instance, in-memory)

HTTP: 30 lookups / 60 s per UID. WebSocket: 30 connection attempts / 60 s per IP (pre-auth), 20 subscribe attempts / 60 s per UID (order probing), ≤ 5 concurrent sockets per UID, ≤ 5 rooms per socket, and sockets are force-closed after 55 minutes so a connection can't outlive its Firebase token (clients reconnect with a fresh one). Behind a proxy, `handshake.address` is the proxy's address unless the deployment forwards the client IP — the per-IP limit needs review then.

## Multi-instance behavior

`DeliveryEventHub` is in-process. When `REDIS_URL` is set the gateway attaches the `@socket.io/redis-adapter` (Redis Pub/Sub), so `io.to(room).emit` from the instance that handled the driver's ping reaches customers connected to other instances, and `socketsLeave` also works cluster-wide. Without `REDIS_URL` fan-out is **single-instance only** (development). The adapter path is **untested** here (no Redis), so horizontal scalability is designed-for, not verified. Rate limits and the driver-eligibility cache remain per instance.

## Failure behavior

Redis down: HTTP snapshot and subscribe snapshot degrade to `available:false`; the driver ping path answers 503 (decision 022); the server keeps running. Realtime fan-out errors never fail a driver's request (fire-and-forget). Geocoder problems only drop `destination`.

## Why the Customer App's Firestore stays untouched

The Customer App order is only *read* (`getOrderById`) to check ownership, shop and address; nothing is written, no field added, no rules or schema changed, and no Duo-Face state is copied into it. Tests assert `updateOrderStatus` is never called.

## What the existing Customer App must integrate

1. Send its Firebase ID token: `Authorization: Bearer` for `GET /customer/orders/:orderId/tracking`; `auth: {token}` in the Socket.IO handshake (Socket.IO client for Dart/Swift/Kotlin/JS exists).
2. On the tracking screen: GET the snapshot (or `subscribe` and use the initial `snapshot`), then apply `driver_location`/`delivery_status`/`tracking_ended`.
3. Show "Live location is currently unavailable" when `available:false`, and distinguish `fresh:false` from live.
4. Refresh the ID token and reconnect when the socket is closed (≤ 55 min lifetime).
5. Use any map SDK with the returned coordinates; do not geocode addresses client-side.

## Not verified

No Customer App UI (not in this repo), no real Customer Firebase session, no real Redis or Redis Pub/Sub/adapter, no multi-instance run, no device. The gateway/HTTP logic is tested with fakes and a local WebSocket.
