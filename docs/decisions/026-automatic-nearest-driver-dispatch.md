# 026 — Automatic nearest-driver dispatch

Supersedes the manual "assign a driver" flow of [016](016-merchant-driver-assignment-ui.md).

## Decision
A merchant **raises a driver request** for an order; the server picks the driver. Merchants never see a driver list and never send a `driverId`.

- `POST /merchant/deliveries` body is `{ orderId }` only (`.strict()` — a `driverId` or `customerAppShopId` is a 400). Shop ownership comes from `req.shop`.
- `GET /merchant/drivers` is removed.
- `DeliveryAssignmentService.assignDriver` stays as an internal domain method used only by `DriverDispatchService`.

## How the driver is chosen (`services/driverDispatchService.ts`)
1. The order must belong to the merchant's linked Customer App shop (otherwise 404, same as 011).
2. **Pickup point**, first hit wins: (a) the Duo-Face shop's stored `pickupLocation` (`duo_face_shops`, additive optional field; set at provisioning — explicit, or geocoded once from the Customer App shop address — and correctable with `DuoFaceShopService.setPickupLocation` / `MerchantProvisioningService.backfillPickupLocation`); (b) else the Customer App shop's text `address` geocoded with the existing cached `DeliveryGeocoder` (021); (c) else `409 Shop location unavailable.` Coordinates are never guessed. Re-offers after a rejection resolve the shop by `customerAppShopId` (`findByCustomerAppShopId`, single-field query) and use the same order.
3. **Eligible drivers**: status `active` **and on duty** (027); a location no older than 10 minutes (`DUTY_LOCATION_STALE_AFTER_MS`) — the live Redis fix (022) if present, else the last Firestore fix, which the on-duty app refreshes every minute (019/027); and **not on an active delivery** (`assigned`/`accepted`/`picked_up`, so a driver with a pending offer is also "busy").
4. Drivers who already **rejected or let an offer expire** for this order are excluded (derived from the order's existing assignments — no new stored fields).
5. Rank by great-circle distance to the pickup point (`services/geo.ts`, ties by `driverId`) and assign the nearest. No eligible driver → `409 No driver available nearby right now.` — there is deliberately **no fallback** to a far or unlocated driver. Distances are internal and never returned or logged.

## Rejection and timeout
- A committed `rejected` transition re-offers the order to the next-nearest driver in the background (`DispatchTrigger` hub, installed in `server.ts`; same fire-and-forget rule as lifecycle effects — it can never fail the driver's action). When nobody is left the order simply has no active assignment and the merchant can request again.
- An offer unanswered after `OFFER_TTL_MS` (2 min) is expired: `assigned → cancelled` (new edge in `deliveryAssignmentTransitions.ts`; drivers cannot trigger it) and re-offered. Expiry is **lazy**: it is applied when the merchant lists orders/deliveries, and a driver trying to accept or reject a stale offer gets `409 This offer expired.`. The lazy path is the source of truth, so a server restart cannot strand an order.

## Known limits
- Requires a configured geocoder (`OPENCAGE_API_KEY`), otherwise every request answers "Shop location unavailable".
- Expiry/re-offer happens when the merchant next views orders or deliveries (or a driver answers late); there is no scheduler. A scheduled job or queue would make it push-style.
- Two simultaneous requests for different orders can both pick the same nearest driver (the "busy" check is a read, not a lock). The driver then holds two offers; either can be rejected and is re-offered.
- Drivers learn of an offer through the existing `delivery_assigned` notification effect and by opening the app; no realtime `order.offer` event is added here.
