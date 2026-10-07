# 032 — "Call customer" for the driver, only near the delivery location

Status: implemented. Supersedes the "driver never sees the customer's number" rule of [028](028-delivery-proof-and-masked-calls.md), now that Exotel (masked calls) is removed.

## Rule
- The Partner app shows a **Call customer** button on the delivery screen only while the order is `picked_up` and the driver's own phone reports a fix within **300 m** of the delivery point (accuracy ≤ 100 m). Tapping it opens a small dialog; its **Call customer** button opens the phone's dialer (`tel:`).
- The button is a hint. The number is released by `POST /driver/assignments/:id/customer-contact` with a fresh GPS fix taken at tap time. `CustomerContactService` re-checks: the assignment is the driver's own (404 otherwise), status is `picked_up`, the delivery point is known, accuracy ≤ 100 m, distance ≤ 300 m. Otherwise 409 with a rounded distance and never the number or the customer's coordinates.
- Everywhere else the driver still never receives the number: the normal order view (`GET /driver/assignments/:id/order`) is unchanged and has no phone field. The number is not logged. Rate limit: 10 requests per minute per driver.
- The call is a normal phone call from the driver's own SIM, so **the customer sees the driver's number** and the driver sees the customer's.

## Why
A masked call needs Exotel (paid account, ExoPhone, public URL), which is not set up. Calling only near the address limits how long the number is exposed and prevents browsing customers' numbers from the road.

## Files
`server/src/services/customerContactService.ts`, `routes/driver/assignments.ts`, `DeliveryOrderService.getForDriverWithPhone`, `tests/services/customerContact.test.ts`; app: `components/DeliveryProofPanel.tsx`, `lib/deliveryProximity.ts`, `api/driver.ts`, preview data.

## To verify on devices
Pick up an order, walk to within 300 m: the button appears; farther away it is hidden (and the server refuses a forged request). Tap, confirm, the dialer opens with the customer's number.
