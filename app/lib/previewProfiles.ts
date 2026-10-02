import { ApiError } from '@/api/errors';
import type { BankInput, BankView, Completeness, DriverProfile, DriverProfileInput, MerchantProfile, MerchantProfileInput, VerificationStatus } from '@/api/profile';
import type { PreviewRole } from '@/lib/preview';

/**
 * DEVELOPMENT-ONLY (lib/preview.ts): in-memory profiles so both profile
 * screens can be exercised without a backend. It mirrors the server's
 * masking and review-status rules (server/src/services/*ProfileService.ts):
 * full Aadhaar/PAN/account numbers are NEVER kept, only masked values.
 */

const mask = (value: string, visible = 4) => `${'•'.repeat(Math.max(0, value.length - visible))}${value.slice(-visible)}`;
const compact = (value: string) => value.replace(/[\s-]/g, '');

/** Tiny inline "photo" so thumbnails render with no network. */
const photoData = (colour: string, letter: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="${colour}"/><text x="200" y="175" font-size="120" text-anchor="middle" fill="white" font-family="sans-serif">${letter}</text></svg>`)}`;

function nextStatus(previous: VerificationStatus, complete: boolean, changed: boolean): VerificationStatus {
  if (!complete) return 'incomplete';
  if (previous === 'verified') return changed ? 'pending_review' : 'verified';
  return 'pending_review';
}

function bankView(input: BankInput, previous: BankView | null): BankView {
  return {
    accountHolderName: input.accountHolderName,
    accountMasked: input.accountNumber ? `••••${compact(input.accountNumber).slice(-4)}` : (previous?.accountMasked ?? null),
    ifsc: input.ifsc.toUpperCase(),
    bankName: input.bankName ?? null,
    upiId: input.upiId ?? null,
  };
}

function completeness(sections: Completeness['sections']): Completeness {
  const required = sections.filter((s) => !s.optional);
  return { sections, completed: required.filter((s) => s.done).length, total: required.length };
}

// ---- driver ----
const driver: DriverProfile = {
  personal: null,
  identity: { aadhaarMasked: null, panMasked: null, licenceMasked: null, licenceExpiry: null },
  vehicle: null,
  bank: null,
  photos: { selfieUrl: null, vehicleUrl: null },
  kycStatus: 'incomplete',
  bankStatus: 'incomplete',
  payoutReady: false,
  commissionBps: 1000,
  completeness: { sections: [], completed: 0, total: 5 },
};

function refreshDriver(kycChanged: boolean, bankChanged: boolean) {
  const p = driver.personal;
  const personal = Boolean(p?.fullName && p.contactPhone && p.dateOfBirth && p.address.line1 && p.emergencyContact.name);
  const identity = Boolean(driver.identity.aadhaarMasked && driver.identity.panMasked && driver.identity.licenceMasked && driver.identity.licenceExpiry);
  const vehicle = Boolean(driver.vehicle?.registrationNumber);
  const bank = Boolean(driver.bank?.accountMasked && driver.bank.ifsc);
  const photos = Boolean(driver.photos.selfieUrl && driver.photos.vehicleUrl);
  driver.kycStatus = nextStatus(driver.kycStatus, personal && identity && vehicle && photos, kycChanged);
  driver.bankStatus = nextStatus(driver.bankStatus, bank, bankChanged);
  driver.payoutReady = driver.kycStatus === 'verified' && driver.bankStatus === 'verified';
  driver.completeness = completeness([
    { key: 'personal', label: 'Personal details', done: personal },
    { key: 'identity', label: 'Identity & licence', done: identity },
    { key: 'vehicle', label: 'Vehicle', done: vehicle },
    { key: 'bank', label: 'Bank & payouts', done: bank },
    { key: 'photos', label: 'Live photos', done: photos },
  ]);
}

function patchDriver(input: DriverProfileInput): DriverProfile {
  let kyc = false;
  let bankChanged = false;
  if (input.personal) {
    driver.personal = { ...input.personal };
    kyc = true;
  }
  if (input.identity) {
    const i = input.identity;
    if (i.aadhaarNumber) driver.identity.aadhaarMasked = `XXXX-XXXX-${compact(i.aadhaarNumber).slice(-4)}`;
    if (i.panNumber) driver.identity.panMasked = mask(compact(i.panNumber).toUpperCase());
    if (i.licenceNumber) driver.identity.licenceMasked = mask(compact(i.licenceNumber).toUpperCase());
    if (i.licenceExpiry) driver.identity.licenceExpiry = i.licenceExpiry;
    kyc = true;
  }
  if (input.vehicle) {
    driver.vehicle = { ...input.vehicle, registrationNumber: compact(input.vehicle.registrationNumber).toUpperCase() };
    kyc = true;
  }
  if (input.bank) {
    driver.bank = bankView(input.bank, driver.bank);
    bankChanged = true;
  }
  refreshDriver(kyc, bankChanged);
  return { ...driver };
}

// ---- merchant ----
const merchant: MerchantProfile = {
  personal: null,
  identity: { panMasked: null, gstin: null, fssai: null },
  bank: null,
  pickupLocation: null,
  photoUrl: null,
  kycStatus: 'incomplete',
  bankStatus: 'incomplete',
  payoutReady: false,
  commissionBps: 1000,
  completeness: { sections: [], completed: 0, total: 4 },
};

function refreshMerchant(kycChanged: boolean, bankChanged: boolean) {
  const p = merchant.personal;
  const personal = Boolean(p?.shopName && p.ownerName && p.contactPhone && p.address.line1);
  const identity = Boolean(merchant.identity.panMasked);
  const bank = Boolean(merchant.bank?.accountMasked && merchant.bank.ifsc);
  merchant.kycStatus = nextStatus(merchant.kycStatus, personal && identity, kycChanged);
  merchant.bankStatus = nextStatus(merchant.bankStatus, bank, bankChanged);
  merchant.payoutReady = merchant.kycStatus === 'verified' && merchant.bankStatus === 'verified';
  merchant.completeness = completeness([
    { key: 'personal', label: 'Shop & owner', done: personal },
    { key: 'identity', label: 'PAN & tax details', done: identity },
    { key: 'bank', label: 'Bank & payouts', done: bank },
    { key: 'location', label: 'Pickup location', done: merchant.pickupLocation !== null },
    { key: 'photo', label: 'Photo', done: merchant.photoUrl !== null, optional: true },
  ]);
}

function patchMerchant(input: MerchantProfileInput): MerchantProfile {
  let kyc = false;
  let bankChanged = false;
  if (input.personal) {
    merchant.personal = { ...input.personal };
    kyc = true;
  }
  if (input.identity) {
    if (input.identity.panNumber) merchant.identity.panMasked = mask(compact(input.identity.panNumber).toUpperCase());
    if (input.identity.gstin) merchant.identity.gstin = input.identity.gstin.toUpperCase();
    if (input.identity.fssai) merchant.identity.fssai = input.identity.fssai;
    kyc = true;
  }
  if (input.bank) {
    merchant.bank = bankView(input.bank, merchant.bank);
    bankChanged = true;
  }
  if (input.pickupLocation) merchant.pickupLocation = { ...input.pickupLocation };
  refreshMerchant(kyc, bankChanged);
  return { ...merchant };
}

/** Handles /{role}/profile... in preview mode. Returns undefined for any other path. */
export function previewProfileRoute(role: PreviewRole, method: string, pathname: string, body: Record<string, unknown>): unknown {
  const seg = pathname.split('/').filter(Boolean);
  if (seg[0] !== role || seg[1] !== 'profile') return undefined;
  const sub = seg[2];

  if (!sub && method === 'GET') {
    if (role === 'driver') {
      refreshDriver(false, false);
      return { ...driver };
    }
    refreshMerchant(false, false);
    return { ...merchant };
  }
  if (!sub && method === 'PATCH') {
    if (Object.keys(body).length === 0) throw new ApiError(400, 'Nothing to update.', 'invalid_request');
    return role === 'driver' ? patchDriver(body as DriverProfileInput) : patchMerchant(body as MerchantProfileInput);
  }

  if (sub === 'photo-upload' && method === 'POST') {
    return { uploadUrl: 'https://preview.invalid/upload', objectKey: `${role}/preview/${String(body.kind)}/${Date.now()}.jpg`, headers: {}, expiresInSeconds: 300 };
  }
  if (sub === 'photo-confirm' && method === 'POST') {
    const kind = String(body.kind);
    if (role === 'driver') {
      if (kind === 'selfie') driver.photos.selfieUrl = photoData('#4f46e5', 'Me');
      if (kind === 'vehicle') driver.photos.vehicleUrl = photoData('#0f766e', '🛵');
      refreshDriver(true, false);
    } else {
      merchant.photoUrl = photoData('#059669', 'S');
      refreshMerchant(false, false);
    }
    return null;
  }
  if (sub === 'photo' && method === 'DELETE') {
    const kind = seg[3];
    if (role === 'driver') {
      if (kind === 'selfie') driver.photos.selfieUrl = null;
      if (kind === 'vehicle') driver.photos.vehicleUrl = null;
      refreshDriver(true, false);
    } else {
      merchant.photoUrl = null;
      refreshMerchant(false, false);
    }
    return null;
  }
  return undefined;
}
