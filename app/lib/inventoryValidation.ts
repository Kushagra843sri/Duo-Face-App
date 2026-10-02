/**
 * Pure and exported so it's ready to test once the app has a test
 * framework — none exists yet. Mirrors the server's own zod constraints
 * (server/src/routes/merchant/inventory.ts: `int().min(0)` for quantity,
 * non-zero int for delta) so bad input is caught before the request, while
 * the server remains the actual enforcement point.
 */

const NON_NEGATIVE_INTEGER = /^\d+$/;

export function parseQuantityInput(text: string): number | null {
  const trimmed = text.trim();
  if (!NON_NEGATIVE_INTEGER.test(trimmed)) {
    return null;
  }
  return Number.parseInt(trimmed, 10);
}

export function parseAdjustmentAmount(text: string): number | null {
  const trimmed = text.trim();
  if (!NON_NEGATIVE_INTEGER.test(trimmed) || trimmed === '0') {
    return null;
  }
  return Number.parseInt(trimmed, 10);
}
