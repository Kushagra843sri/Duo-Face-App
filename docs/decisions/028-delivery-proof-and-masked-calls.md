# 028 — Delivery proof (50 m rule + customer code) and masked customer calls

> **Update (2026-10-08): Exotel was removed.** Sections 2 (code by SMS) and 3 (masked calls) below are history only: there is no "Call customer" button, no `/webhooks/exotel`, no `duo_face_call_logs` writes and no `EXOTEL_*`/`CALL_WEBHOOK_SECRET` settings. The delivery code is shown to the customer in the Customer App (once the order is out for delivery) and the customer tells it to the driver; the 50 m GPS proof is unchanged. If calling is wanted again, re-add a provider behind a new decision (the code is in git history before this change).

Supersedes the "driver sees the customer's phone number after accepting" rule of [018](018-delivery-order-read-boundary.md)/[019](019-driver-location-foundation.md).

## 1. "Mark delivered" needs proof of arrival
`POST /driver/assignments/:id/deliver` now takes **exactly one** proof (`.strict()`; a `driverId` or anything else is a 400):
- `{ location: { latitude, longitude, accuracyMeters } }` — a fresh GPS fix taken **at tap time** (not a cached watcher value). Accepted only if `accuracyMeters ≤ 50` **and** the distance to the customer is `≤ 50 m` (`DELIVERY_RADIUS_METERS`). A fix with a wider error circle cannot prove "within 50 m", so it is refused. The refusal says "about 70 m" (rounded to 10 m) and never reveals the customer's coordinates.
- `{ otp: "123456" }` — the customer's delivery code (fallback, §2). Skips the distance check.

All rules live in `DeliveryProofService`; the route is thin. Ownership and status are re-checked (404 for another driver's assignment, 409 unless `picked_up`). On success it calls the unchanged `markDelivered` (same transaction, Customer App sync, notifications).

The app mirrors the rule only as a **hint**: it watches the driver's position on the delivery screen, shows "You're about 120 m away. Get within 50 m to mark delivered", and enables the button only when within 50 m with good accuracy. The server is the authority.

### Why there is a code fallback
The Customer App stores only a **text address**, so the destination is a geocoded point (decision 021) that can be tens to hundreds of metres off — and `GEOCODER_MIN_CONFIDENCE` defaults to 7 (~5 km!). A strict 50 m test against that point can lock a driver out at the customer's real door. For the 50 m rule to mean anything, set `GEOCODER_MIN_CONFIDENCE=9` or `10` (and expect more "location unavailable" results, which also route to the code). Real customer coordinates (captured by the Customer App) would be the proper fix.

## 2. Delivery code (OTP)
- Generated (CSPRNG, 6 digits) **inside the `picked_up` transaction**; stored on the assignment only as `HMAC-SHA256(DELIVERY_OTP_SECRET, "delivery-otp:<assignmentId>:<code>")` plus `deliveryOtpAttempts` / `deliveryOtpLockedAt`. The plaintext lives in memory until it is sent after commit and is never stored, logged or returned. It is in no DTO.
- Sent to the customer's number on the order by **SMS via Exotel** (needs a DLT-registered sender, entity and template; `EXOTEL_SMS_*`). Push is not used for the code (the Customer App does not register devices, and the push copy contract is PII-free).
- Verification is constant-time, counted atomically with the check, and a wrong guess is persisted before the error is returned. **5 wrong codes lock the code** (`423`); a locked code rejects even the right digits. The location path still works after a lock.
- `DELIVERY_OTP_SECRET` unset → no code is generated or sent; the code path answers 409 and the driver must be within 50 m.

## 3. Masked calling (drivers never see the customer's number)
- The driver order DTO **no longer contains `phoneNumber`**; it has `canCallCustomer` (accepted or picked up, and the order has a number). Merchants still receive the number (they are the business) — masking that is a separate decision.
- `POST /driver/assignments/:id/call-customer` (no body): ownership 404; status must be `accepted`/`picked_up`; the driver needs a phone on their profile; at most **5 calls per assignment per 30 min** plus a per-driver rate limit. The server reads the customer's number from the Customer App order and asks Exotel to **connect two numbers**: it rings the **driver first** (`From`), then the customer (`To`), with the ExoPhone as `CallerId`. Each side sees only the ExoPhone. `TimeLimit` caps a call at 10 minutes; recording is off.
- Provider errors never reach the driver (generic 503) and never contain a number. `duo_face_call_logs/{callId}` records ids, Exotel sid, status and duration — **no phone numbers**.
- `POST /webhooks/exotel/call-status?callId=…&t=…` receives Exotel's terminal status. Exotel documents no callback signature, so the URL carries `t = HMAC(CALL_WEBHOOK_SECRET, callId)`, verified in constant time; forged/unknown calls are ignored and always answered 200.

## 4. Configuration (`server/.env`, see `.env.example`)
`EXOTEL_ACCOUNT_SID`, `EXOTEL_API_KEY`, `EXOTEL_API_TOKEN`, `EXOTEL_SUBDOMAIN` (default `api.in.exotel.com`), `EXOTEL_CALLER_ID` (ExoPhone), `PUBLIC_BASE_URL` (public HTTPS origin Exotel can reach), `CALL_WEBHOOK_SECRET`, `DELIVERY_OTP_SECRET`, and for the code SMS `EXOTEL_SMS_SENDER`, `EXOTEL_DLT_ENTITY_ID`, `EXOTEL_DLT_TEMPLATE_ID`, `EXOTEL_SMS_TEMPLATE` (exact approved text containing `{code}`). Anything missing disables that feature safely: calls answer 503, no code is sent.

## 5. Limits
- GPS can be faked with mock-location apps; the server cannot detect it. The code is the stronger proof.
- If the customer never receives the code (no SMS template yet, wrong number) the driver can only finish within 50 m.
- Exotel needs a paid account, a purchased ExoPhone, DLT registration for SMS, a public callback URL, and per-minute costs on every bridged call.
- Not verified against real Exotel/GPS here (tests use fakes).

## 6. Manual test checklist
1. Pick up an order; the customer's phone gets the SMS code (or, without SMS config, confirm the code path answers "not available").
2. Stand >50 m away: **Mark delivered** is disabled; the hint shows the distance. Walk within 50 m: it enables and completes.
3. Outside 50 m: **Enter customer code** with the right code completes; 5 wrong codes lock it.
4. **Call customer**: your phone rings first, then the customer's; neither sees the other's number; a row appears in `duo_face_call_logs` with a status/duration and no numbers.
