import { createHash } from 'crypto';

/**
 * Deterministic address normalization used ONLY to build the cache key
 * (the provider is sent the trimmed original, which geocodes better):
 *
 *  1. Unicode NFKC (folds full-width/compatibility forms)
 *  2. lower-case (locale-independent)
 *  3. every run of characters that are not a Unicode letter, combining
 *     mark (needed for Devanagari etc.) or number
 *     (spaces, commas, periods, hyphens, slashes...) becomes one space
 *  4. trim
 *
 * "12/A, MG Road,  Delhi." and "12 a mg road delhi" are the same address;
 * different tokens or token order are different addresses (no fuzzy
 * matching — a wrong cache hit would send a driver to the wrong place).
 * Non-Latin scripts (e.g. Devanagari) are preserved.
 */
export function normalizeAddress(rawAddress: string): string {
  return rawAddress
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * SHA-256 (hex) of the normalized address; also the Firestore document id
 * of duo_face_delivery_destinations/{hash}, so the raw address is never an
 * id. Note: unsalted, so it is a stable key, not anonymization —
 * `normalizedAddress` is stored alongside it on purpose (docs/decisions/021).
 */
export function hashNormalizedAddress(normalizedAddress: string): string {
  return createHash('sha256').update(normalizedAddress, 'utf8').digest('hex');
}
