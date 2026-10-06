# First real end-to-end run: checklist

Goal: prove, once, with a real Firebase project (and a Cashfree **sandbox**), that a customer, a shop, a driver and an admin can complete real work together. Everything so far was verified against in-memory fakes (`server/tests/e2e/`); this run is the first contact with real Firestore, real Auth and a real payment provider.

**Rules for this run**
- Test data and sandbox keys only. Never put Cashfree *production* keys, real customer data or real bank details anywhere in this run.
- Tick each box as you go. If a step fails, stop and note it in the log at the bottom (section 12); do not skip ahead, later steps depend on earlier ones.
- Keep it on one laptop. Nothing here needs a public server except the optional Cashfree webhook (section 8).

Time: about 2-3 hours the first time, most of it in the Firebase and Cashfree consoles.

---

## 0. Know what will NOT work yet (so you don't chase it)

| Not available in this run | Why | Effect |
|---|---|---|
| Shop / driver / admin sign-in **on a phone** | Phone OTP works only in the **web** build (decision 017); native needs a development build with native Firebase | Run the Merchant/Driver/Admin app **in the browser** |
| Push notifications | Needs an Android development build + `google-services.json` | Not needed: the in-app inbox (bell) shows every notification |
| iOS anything | No Apple push / dev build set up | Skip iOS |
| Driver **KYC reaching review** | Needs both live photos, which need private R2 storage | Test KYC with the **shop owner** instead (no photos needed); driver KYC is an optional extra (section 10) |
| Masked "Call customer", delivery-code **SMS** | Needs Exotel + DLT registration | Skip. The customer reads the code in the app |
| Address geocoding | No OpenCage key | Not needed: the customer's saved GPS point is used |
| Background / on-duty location while the app is closed | Web only runs while the tab is open | Keep the driver tab open |
| Native live map | `react-native-maps` has no web version | On web the customer sees driver coordinates as text |

---

## 1. Prerequisites

- [ ] Node.js (the version the repo uses) and `npm install` done in `server/`, `app/` and `customer/`.
- [ ] `cd server && npm test` passes (expect **1080** tests). If not, stop: something in your checkout is off.
- [ ] A Google account for the Firebase console.
- [ ] A Cashfree account (sandbox only needs sign-up; no KYC).
- [ ] A free Redis: an Upstash database (`rediss://...` URL) or a local Redis. Needed for live driver tracking only.
- [ ] (Optional, for the Cashfree webhook) a tunnel tool such as `cloudflared` to expose `localhost:4000` over HTTPS.

---

## 2. Firebase project (free Spark plan is enough)

Follow `docs/integration/FIREBASE_SETUP.md` sections 1-5, summarised here as a checklist:

- [ ] Create the project, analytics off.
- [ ] **Authentication → Sign-in method:** enable **Email/Password** (customer app) **and Phone** (shop/driver/admin app).
- [ ] **Phone → "Phone numbers for testing":** add **three** test numbers with fixed codes (e.g. `+91 99999 00001` → `123456`, `…00002`, `…00003`). Phone sign-in then costs nothing and sends no SMS.
- [ ] **Authentication → Settings → Authorized domains:** `localhost` is present.
- [ ] **Firestore Database → Create database:** *Production mode*, region `asia-south1` (cannot be changed later).
- [ ] **Firestore → Rules:** paste the deny-everything rules from `FIREBASE_SETUP.md` section 3 and **Publish**. (The server uses the Admin SDK, which bypasses rules.)
- [ ] **Project settings → Your apps → Web app:** register one; copy the 4 values (`apiKey`, `authDomain`, `projectId`, `appId`).
- [ ] **Project settings → Service accounts → Generate new private key:** download the JSON. Keep it **outside the repo**.

---

## 3. Server configuration (`server/.env`)

Create `server/.env` (gitignored). Minimum for this run:

```
NODE_ENV=development
PORT=4000
# Required for the browser apps to be allowed to call the server (CORS is closed by default):
CORS_ORIGIN=http://localhost:8081,http://localhost:8082

FIREBASE_PROJECT_ID=<project id>
FIREBASE_CLIENT_EMAIL=<client_email from the JSON>
FIREBASE_PRIVATE_KEY="<private_key from the JSON, keep the \n escapes, wrap in quotes>"

PROFILE_ENCRYPTION_KEY=<node -e "console.log(require('crypto').randomBytes(32).toString('base64'))">
DELIVERY_OTP_SECRET=<16+ random characters>
CALL_WEBHOOK_SECRET=<16+ random characters>
REDIS_URL=<rediss://...>
ADMIN_FIREBASE_UIDS=            # filled in during section 5
```

Leave unset for now: `PUSH_NOTIFICATIONS_ENABLED`, `OPENCAGE_API_KEY`, `EXOTEL_*`, `R2_*`, `CASHFREE_*` / `PUBLIC_BASE_URL` (added in section 8).

- [ ] `.env` is in place and **not** tracked by git (`git status` does not list it).
- [ ] `cd server && npm run dev` starts and prints `listening on port 4000`.
- [ ] `curl http://localhost:4000/health` → `{"status":"ok"}`.
- [ ] Back up `PROFILE_ENCRYPTION_KEY` somewhere safe (losing it makes stored PAN/licence/bank values unreadable).

---

## 4. Start the apps (browser)

Two Expo web apps need different ports, and both must match `CORS_ORIGIN`:

```
cd app       && npx expo start --web --port 8081     # shops, drivers, admin
cd customer  && npx expo start --web --port 8082     # customers
```

Create `app/.env.local` and `customer/.env.local` with the 4 `EXPO_PUBLIC_FIREBASE_*` values from section 2. Leave `EXPO_PUBLIC_UI_PREVIEW` **unset** (otherwise you get sample data, not the real server). Restart each dev server after editing env files.

- [ ] `http://localhost:8082` shows the customer **sign-in** screen (not "Sign-in is not configured" and no PREVIEW banner).
- [ ] `http://localhost:8081` shows the phone sign-in screen.
- [ ] Use **separate browser profiles or private windows** for each person, so sessions don't mix: customer, shop, driver, admin.

---

## 5. Create the four people

| Person | App | Sign in with |
|---|---|---|
| Customer | `localhost:8082` | **Create an account** with an email + password |
| Shop owner | `localhost:8081` | test phone number 1 + code |
| Driver | `localhost:8081` | test phone number 2 + code |
| Admin | `localhost:8081` | test phone number 3 + code |

- [ ] Customer account created and lands on the shops tab.
- [ ] Shop owner signs in → the **"Create your account"** screen → choose the shop option → enter the **Shop name** → **Create account** → lands on the shop dashboard.
- [ ] Driver signs in → **"Create your account"** → choose the delivery option → enter **Your name** → **Create account** → lands on the driver dashboard.
- [ ] **Admin:** sign in with test number 3, **stop at the choice screen (do not register)**. In the Firebase console → Authentication → Users, copy that user's **User UID** → put it in `ADMIN_FIREBASE_UIDS` → restart the server → reload the browser tab. You should land in the **admin** area (Refunds / KYC review tabs).
- [ ] In Firestore you now see `duo_face_identities` (2 docs: the shop owner and the driver; the admin has none, being allowlisted), `duo_face_shops` and `duo_face_drivers`, **and `shops/<same id as the duo_face_shops doc>`** (closed, `isActive: true`).

---

## 6. Set up the shop and the driver

**Shop owner (`localhost:8081`)**
- [ ] Dashboard says **"Your shop is closed"**.
- [ ] Profile → shop details: shop name, owner, phone, address → Save. (The customer app will show this name/address.)
- [ ] Profile → **pickup location → use my location** (allow the browser's location prompt) → Save. **Required:** dispatch cannot find a pickup point otherwise.
- [ ] Products → **Add product** → e.g. *Toned Milk 500 ml*, price `28.50`, starting stock `10`. Add a second product too.
- [ ] Dashboard → **open the shop**; the card says "Your shop is open".

**Driver (`localhost:8081`)**
- [ ] Dashboard → go **on duty**. Keep this tab open and allow location (it shares position about once a minute while open).
- [ ] Firestore: `duo_face_driver_locations/<driverId>` appears. If it doesn't, the location prompt was blocked.

**Customer (`localhost:8082`)**
- [ ] The shop appears with its name/address and **Open**; its products show with their prices.
- [ ] Profile → Saved addresses → add an address and tap **use my current location** (so the address carries a GPS point).

---

## 7. The main flow: cash on delivery, shop → driver → delivered

Do these in order; the expected result is in italics.

- [ ] **Customer:** add 2 × milk to the cart → Checkout → Cash on delivery → **Place order**. *The order page opens; status "Waiting for the shop".*
- [ ] **Shop:** bell shows **1 unread** ("New order"). Orders → open the order. *Items, the customer's address and phone are shown.* Stock for milk is now 8 (Products screen).
- [ ] **Shop:** tap **Accept order**. **Customer:** *within ~15 s the status becomes Confirmed and the bell shows "Order confirmed".*
- [ ] **Shop:** **Start preparing**, then **Mark ready for pickup**. *Customer sees each status.*
- [ ] **Shop:** **Request driver**. *The driver is offered the job.* If it answers "no driver available": check the driver is on duty, has a recent location, and the shop has a pickup location (section 6).
- [ ] **Driver:** bell shows "New delivery offer" → Assignments → **Accept**. **Shop:** bell shows "Delivery partner on the way".
- [ ] **Driver:** **Mark picked up**. *Customer: status "On the way", and a 6-digit **delivery code** appears on the order page.*
- [ ] **Driver:** the order screen shows the customer's address and a **destination** (no customer phone anywhere).
- [ ] **Customer:** the order page shows the driver's position (as coordinates on web). Optional: tracking updates only while the driver tab shares location.
- [ ] **Driver:** **Mark delivered** → enter the customer's **6-digit code**. A wrong code is refused; the right one completes it.
- [ ] **Everyone:** *the order is **Delivered** for the customer and the shop; both lists show the finished delivery.*
- [ ] **Customer inbox** contains, in order: Order confirmed, Delivery partner assigned, accepted, Order picked up, (Driver nearby, only if the driver position was within 300 m), Order delivered.

Firestore spot-check (the data model on a real database):
- [ ] `orders/<id>`: `status: delivered`, `paymentMethod: cod`, `pricingPaise.total: 5700`.
- [ ] `order_events`: one document per status step, with who did it.
- [ ] `duo_face_inventory`: milk quantity is 8.
- [ ] `duo_face_delivery_codes/<orderId>`: the `code` field is **encrypted** (starts with `v1:`), not 6 digits.
- [ ] `duo_face_inbox/<uid>/items/*` exist for the customer, shop and driver.

---

## 8. Online payment and refund (Cashfree sandbox)

Add to `server/.env`, then restart the server:

```
CASHFREE_APP_ID=<sandbox App ID>
CASHFREE_SECRET_KEY=<sandbox Secret Key>
CASHFREE_ENV=sandbox
PUBLIC_BASE_URL=<an https URL that reaches localhost:4000>
```

`PUBLIC_BASE_URL` must be HTTPS (Cashfree requires it for the webhook). Start your tunnel (e.g. `cloudflared tunnel --url http://localhost:4000`) and use the URL it prints. Payment still works **without** the webhook (the app asks the server, which asks Cashfree), but the webhook is part of what this run should prove.

- [ ] Customer app checkout now offers **Pay online**.
- [ ] **Customer:** place an online order → the payment page opens (hosted by the server, then Cashfree) → pay using Cashfree's **sandbox test payment details** (see Cashfree's docs, Developers → test data; use only those). *Back on the order screen it flips to **Paid online** within seconds.*
- [ ] **Shop:** the order only appeared **after** payment (it was hidden while unpaid), with a "New order" notification.
- [ ] Firestore: `duo_face_payments/cf_...` has `status: paid` and the right `paidAmountPaise`; `orders/<id>.paymentStatus: paid`.
- [ ] Server log shows the webhook hit (`POST /webhooks/cashfree` 200). If you skipped the tunnel, note that here.
- [ ] **Unpaid expiry:** place another online order and **don't pay**. *After about 15-16 minutes it cancels itself and the stock returns.* (Optional; slow.)
- [ ] **Refund:** the shop **rejects** the paid order. *The customer is told "Order declined"; the **admin** gets "Refund needed".*
- [ ] **Admin:** Refunds tab → open it → **Refund ₹X** → confirm. *Status goes to "In progress", then "Refunded" (use **Check status** if it lingers).* The customer gets "Refund started" then "Refund completed".
- [ ] Cashfree dashboard (sandbox) shows the refund against that order, for the full amount, **once**. Click **Refund** twice quickly on a second test order to confirm only one refund exists.
- [ ] Customer **cannot cancel** a paid online order in the app (expected: "contact support").

---

## 9. Exceptions worth trying for real

- [ ] **Customer cancels** a pending cash order → stock returns, the shop is told.
- [ ] **Closed shop:** shop turns **off** the open switch → the customer's order attempt is refused ("closed right now").
- [ ] **Last unit:** set a product's stock to 1; place the order from two different customers at the same time → exactly one succeeds.
- [ ] **Hide a product** → it disappears from the customer app.
- [ ] **Privacy:** while signed in as customer B, try opening customer A's order link directly → "not found".
- [ ] **Admin screens as a non-admin:** the shop/driver/customer accounts cannot see the admin area.
- [ ] **Rules check:** in the Firebase console Rules Playground (or a quick script with the web config), a *client-side* read/write to `orders` is **denied**.

---

## 10. KYC review (shop owner path)

- [ ] **Shop owner:** Profile → fill the tax section with a valid PAN (format `ABCDE1234F`) and save. *KYC shows "Under review".* **Admin:** bell shows "Verification to review".
- [ ] **Admin:** KYC review tab → open the shop. *PAN shows **masked** (`••••••234F`); the full number never appears.*
- [ ] **Admin:** **Reject…** with no reason → the button stays disabled. Reject with a reason → **Shop owner** sees the reason on the profile and a "Verification needs changes" notification.
- [ ] **Shop owner:** edit and save → back in the admin queue (alerted again). **Admin:** **Approve** → the owner sees **Verified** and a notification.
- [ ] Firestore `duo_face_merchant_profiles/<shopId>`: PAN is stored as ciphertext (`panEnc` starts `v1:`); `reviewHistory` records who decided and when.
- [ ] (Optional) Driver KYC needs R2 for the two live photos: create a **private** Cloudflare R2 bucket (free tier), set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, restart, then repeat with the driver.

---

## 11. Optional extras (only after sections 5-10 are green)

- [ ] **Push on Android:** development build of the customer app (and the shop/driver app) with `GOOGLE_SERVICES_JSON` set, then `PUSH_NOTIFICATIONS_ENABLED=true` on the server.
- [ ] **Customer app on a phone:** Expo Go over the same Wi-Fi (email sign-in works there). Leave `EXPO_PUBLIC_API_URL` unset (it uses the dev machine's address) and add that origin to nothing, since native apps are not subject to CORS.
- [ ] **Real map:** Android build with `GOOGLE_MAPS_ANDROID_API_KEY`.

---

## 12. If something fails: where to look

| Symptom | Likely cause |
|---|---|
| Browser console says **CORS** / network error to `localhost:4000` | `CORS_ORIGIN` missing the app's exact origin (`http://localhost:8081` / `:8082`); restart the server |
| `401` on every call | `FIREBASE_PROJECT_ID` differs from the web app's project, or the private key's `\n` escapes are wrong |
| `403` "no mapped role" after sign-in | Account never completed the register choice, or `duo_face_identities/<uid>` is missing |
| Admin area shows "not authorized" | UID not in `ADMIN_FIREBASE_UIDS`, or the server wasn't restarted |
| Shop dashboard "setup required" (409) | Shop has no linked customer shop; check `duo_face_shops.customerAppShopId` equals the shop's id and `shops/<id>` exists |
| Customer sees the shop but no products | Shop closed is fine (products still list); check each product has stock > 0 and isn't hidden |
| "Request driver" says none available | Driver not on duty, no location in the last 10 minutes, or the shop has no pickup location |
| Tracking says unavailable / 503 | `REDIS_URL` unset or wrong; GPS pings are never written to Firestore as a fallback |
| Delivery code missing for the customer | `PROFILE_ENCRYPTION_KEY` unset (answers 503), or the pickup hasn't completed yet |
| Pay online button missing | `CASHFREE_*` or `PUBLIC_BASE_URL` not set; check `GET /customer/config` returns `onlinePayment: true` |
| Payment done but order stays "Waiting for payment" | Cashfree sandbox keys wrong, or the amount differs; check the server log and `duo_face_payments` status (`amount_mismatch`) |
| Firestore error with a link to **create an index** | Open the link and create it; queries are written to need none, so report which one asked |
| Order seems stuck | Background steps are fire-and-forget; wait a few seconds and refresh, then check the server log for `warn` lines |

---

## 13. Results log

Fill in as you go. Anything marked fail becomes a bug to fix before real users.

| Section | Date | Pass / fail | Notes (error text, what you saw) |
|---|---|---|---|
| 2 Firebase | | | |
| 3 Server boots | | | |
| 4 Apps open | | | |
| 5 People created | | | |
| 6 Shop and driver set up | | | |
| 7 COD flow to delivered | | | |
| 8 Online payment | | | |
| 8 Refund | | | |
| 9 Exceptions | | | |
| 10 KYC | | | |

**Done when:** sections 2-10 pass, the Firestore spot-checks match, and no step needed a code change. Then take stock of every note in the log and decide what to fix before inviting real users.

**After the run:** delete the test documents (or the whole test project), rotate or revoke the service-account key if it was shared, and never reuse sandbox keys in production.
