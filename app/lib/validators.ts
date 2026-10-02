/**
 * Field-level checks mirrored from the server (server/src/validators/indianIds.ts)
 * so people see mistakes before saving. Only a hint: the server re-validates.
 */
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];

const compact = (value: string) => value.replace(/[\s-]/g, '');
export const upper = (value: string) => compact(value).toUpperCase();

export function isValidAadhaar(value: string): boolean {
  const n = compact(value);
  if (!/^[2-9]\d{11}$/.test(n)) return false;
  let c = 0;
  n.split('').reverse().forEach((digit, i) => {
    c = D[c][P[i % 8][Number(digit)]];
  });
  return c === 0;
}
export const isValidPan = (v: string) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(upper(v));
export const isValidIfsc = (v: string) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(upper(v));
export const isValidGstin = (v: string) => /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(upper(v));
export const isValidFssai = (v: string) => /^\d{14}$/.test(compact(v));
export const isValidVehicleNumber = (v: string) => /^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/.test(upper(v));
export const isValidLicence = (v: string) => /^[A-Z]{2}[0-9]{2}[0-9A-Z]{4,13}$/.test(upper(v));
export const isValidAccount = (v: string) => /^\d{9,18}$/.test(compact(v));
export const isValidUpi = (v: string) => /^[a-zA-Z0-9._-]{2,256}@[a-zA-Z]{2,64}$/.test(v.trim());
export const isValidPincode = (v: string) => /^[1-9][0-9]{5}$/.test(v.trim());
export const isValidPhone = (v: string) => /^\+[1-9]\d{7,14}$/.test(v.trim());
export const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());

function realDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
}
export function isAdultDob(value: string, now = new Date()): boolean {
  const date = realDate(value.trim());
  if (!date) return false;
  return date.getTime() <= Date.UTC(now.getUTCFullYear() - 18, now.getUTCMonth(), now.getUTCDate());
}
export function isFutureDate(value: string, now = new Date()): boolean {
  const date = realDate(value.trim());
  return date !== null && date.getTime() > now.getTime();
}

/** A field rule: returns an error message, or null when fine. Empty optional values pass. */
export type Rule = (value: string) => string | null;
export const required = (label: string): Rule => (v) => (v.trim().length === 0 ? `${label} is required.` : null);
export const rule = (test: (v: string) => boolean, message: string, optional = false): Rule => (v) =>
  v.trim().length === 0 ? (optional ? null : message) : test(v) ? null : message;

/** First error per field, or an empty object. */
export function validate(values: Record<string, string>, rules: Record<string, Rule>): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [name, check] of Object.entries(rules)) {
    const message = check(values[name] ?? '');
    if (message) errors[name] = message;
  }
  return errors;
}
