/**
 * Pure format validators for the identity / payout details collected in
 * profiles (docs/decisions/029). A format check is NOT verification: it only
 * stops typos. Whether an Aadhaar/PAN/bank account really belongs to the
 * person needs a KYC provider or manual review.
 */

// ---- Verhoeff (Aadhaar's check digit) ----
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

function verhoeffChecksum(digits: string): number {
  let c = 0;
  const reversed = digits.split('').reverse();
  for (let i = 0; i < reversed.length; i++) c = D[c][P[i % 8][Number(reversed[i])]];
  return c;
}

/** The check digit to append to an 11-digit base (used by tests to build valid numbers). */
export function verhoeffCheckDigit(base: string): number {
  return INV[verhoeffChecksum(`${base}0`)];
}

const digitsOnly = (value: string) => value.replace(/[\s-]/g, '');

/** 12 digits, first digit 2-9, valid Verhoeff checksum. Accepts spaces/hyphens. */
export function isValidAadhaar(value: string): boolean {
  const n = digitsOnly(value);
  return /^[2-9]\d{11}$/.test(n) && verhoeffChecksum(n) === 0;
}

export const normalizeAadhaar = digitsOnly;

export const normalizeUpper = (value: string) => value.replace(/[\s-]/g, '').toUpperCase();

export function isValidPan(value: string): boolean {
  return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(normalizeUpper(value));
}

export function isValidIfsc(value: string): boolean {
  return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(normalizeUpper(value));
}

export function isValidGstin(value: string): boolean {
  return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(normalizeUpper(value));
}

/** FSSAI licence/registration numbers are 14 digits. */
export function isValidFssai(value: string): boolean {
  return /^\d{14}$/.test(digitsOnly(value));
}

/** Indian vehicle registration, e.g. DL1AB1234 / MH12AB1234 / KA01A1234. */
export function isValidVehicleNumber(value: string): boolean {
  return /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/.test(normalizeUpper(value));
}

/** Driving licence: 2-letter state + 2-digit RTO + 4-13 alphanumerics (formats vary by era/state). */
export function isValidLicenceNumber(value: string): boolean {
  return /^[A-Z]{2}[0-9]{2}[0-9A-Z]{4,13}$/.test(normalizeUpper(value));
}

export function isValidBankAccount(value: string): boolean {
  return /^\d{9,18}$/.test(digitsOnly(value));
}

export function isValidUpi(value: string): boolean {
  return /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/.test(value.trim());
}

export function isValidPincode(value: string): boolean {
  return /^[1-9][0-9]{5}$/.test(value.trim());
}

export function isValidPhone(value: string): boolean {
  return /^\+[1-9]\d{7,14}$/.test(value);
}

/** `YYYY-MM-DD` and at least `minAge` years before `now`. */
export function isAdultDob(dob: string, now: Date = new Date(), minAge = 18): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) return false;
  const [y, m, d] = dob.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return false;
  const cutoff = new Date(Date.UTC(now.getUTCFullYear() - minAge, now.getUTCMonth(), now.getUTCDate()));
  return date.getTime() <= cutoff.getTime() && y >= 1900;
}

/** `YYYY-MM-DD`, a real date, strictly after `now`. */
export function isFutureDate(value: string, now: Date = new Date()): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return false;
  return date.getTime() > now.getTime();
}
