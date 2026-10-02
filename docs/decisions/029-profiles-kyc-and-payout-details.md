# 029 — Driver & merchant profiles: details, KYC, bank and photos

## What it is
Each role has a profile page, opened by tapping the coloured name header on the dashboard. Everything is saved through the API (`/driver/profile`, `/merchant/profile`); the app never touches Firestore. The data is what we need to **verify people and pay them after deducting our commission**. Payout execution, commission arithmetic and an admin review UI are **out of scope** (CLAUDE.md: RazorpayX/admin panel).

## Collections (new, Duo-Face-owned; nothing in the Customer App changes)
`duo_face_driver_profiles/{driverId}`, `duo_face_merchant_profiles/{shopId}`. Display fields stay on the main documents and are updated from the profile: driver `name` + `phoneNumber` (merchants see the name; the masked call rings the number), shop `name` and `pickupLocation` (the merchant taps "Use my current location", which also fixes the geocoding-accuracy issue from decision 026).

## What is stored, and how it is protected
| Data | Stored as | Returned to the app as |
|---|---|---|
| Aadhaar | **last 4 digits only** (validated 12 digits + Verhoeff checksum first; the full number is never persisted or logged) | `XXXX-XXXX-1234` |
| PAN, driving licence no., bank account no. | **AES-256-GCM ciphertext** (`PROFILE_ENCRYPTION_KEY`, random nonce per value, context-bound to role/id/field so ciphertext can't be moved to another field or person) + a masked string | `••••••234F`, `••••5678` |
| Name, address, DOB, emergency contact, IFSC, bank name, UPI id, vehicle number/type, GSTIN/FSSAI | plain | plain |
| Photos | only the **object key** (never a URL) | short-lived (5 min) pre-signed view URL, generated per request |

- No encryption key configured → saving PAN / licence / account answers **503**; plaintext is never a fallback. Back the key up: losing it makes stored values unreadable (the `v1:` envelope allows rotation later).
- Full values are never sent back to any app. The server can decrypt (`readSensitive`) for a future payout/support job; nothing exposes that over HTTP.
- Aadhaar is last-4-only on purpose: storing full Aadhaar numbers carries UIDAI compliance duties. A self-declared last 4 is **not** identity verification; that needs a KYC provider or manual document review.

## Server-owned fields
`commissionBps` (basis points; from `PLATFORM_COMMISSION_BPS`, stamped once when a profile is created, read-only to clients), `kycStatus`, `bankStatus` (`incomplete | pending_review | verified | rejected`) and the computed `payoutReady`. Every request schema is `.strict()`: a client sending any of these (or a `driverId`/`shopId`) gets 400. The identity always comes from `req.driver` / `req.shop`.

### Review workflow
- `incomplete` until all required parts exist; then `pending_review` automatically.
- **Nothing becomes `verified` by itself**: only `setVerification` (for a future admin tool/script) does. Editing PAN/Aadhaar/licence/vehicle/photos re-opens KYC; editing bank details re-opens bank review, so details can't be swapped after approval.
- `payoutReady = kycStatus verified && bankStatus verified && bank details present`. A payout job should check this and read the commission from the profile.

Driver KYC needs: personal details, Aadhaar + PAN + licence (+ future expiry), vehicle type and number, **selfie and vehicle photo**. Merchant KYC needs: shop/owner details and PAN (GSTIN/FSSAI optional; photo optional).

## Photos (private Cloudflare R2, pre-signed URLs)
1. `POST /{role}/profile/photo-upload {kind, contentType, sizeBytes}` → the **server** chooses the key `driver/<id>/<kind>/<uuid>.<ext>` and signs a PUT bound to that content type and exact length (JPEG/PNG/WebP, ≤ 5 MB, 5 min).
2. The phone PUTs straight to the bucket.
3. `POST …/photo-confirm {kind, objectKey}` → the server checks the key is under the caller's own prefix and kind, HEADs the object (exists, size, type; bad ones are deleted), then stores the key and deletes the previous object.
Signed URLs and keys are never logged or persisted. The bucket must stay private. Signing is hand-written SigV4 (no new dependency) and is unit-tested against AWS's published example; **it has not been exercised against a real R2 bucket**. Unset `R2_*` → photo endpoints answer 503, the rest works.

### Camera rules
Driver selfie and vehicle photo use `launchCameraAsync` only (there is no gallery path in the UI or code for those kinds). The merchant photo may come from the camera or gallery, is optional, and can be removed; with none, a coloured circle with the initial is shown. Camera-only cannot be made tamper-proof: someone can still photograph a screen.

## Configuration
`PROFILE_ENCRYPTION_KEY` (32 bytes base64: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`), `PLATFORM_COMMISSION_BPS`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`. App: `expo-image-picker` (camera/gallery permission strings in `app.json`).

## Not verified here / manual checklist
Automated tests cover validation, encryption, masking, "no plaintext in storage", status rules, photo rules and ownership. Needs your accounts/devices:
1. Create a **private** R2 bucket + API token; set the `R2_*` vars; in a dev build take a selfie and vehicle photo; confirm both appear and the objects exist under `driver/<id>/…`.
2. Save PAN/bank in a profile and inspect the Firestore document: only `panEnc`/`accountEnc` ciphertext and masked/last-4 strings, never the full numbers.
3. Set `kycStatus`/`bankStatus` to `verified` via `setVerification`, edit the bank account, and confirm `bankStatus` returns to `pending_review` and `payoutReady` is false.
