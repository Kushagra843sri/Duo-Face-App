import { AppError } from '../middleware/errorHandler';

/**
 * Integration boundary: existing Firestore `products.price` is a float in
 * RUPEES. Convert once, explicitly, here; everything Duo-Face computes after
 * this is integer paise. Rejects anything that is not a non-negative amount
 * with at most 2 decimal places rather than guessing.
 */
export function rupeesToPaise(rupees: unknown): number {
  if (typeof rupees !== 'number' || !Number.isFinite(rupees) || rupees < 0) {
    throw new AppError(409, 'A product in the cart has an invalid price');
  }
  const paise = Math.round(rupees * 100);
  if (Math.abs(rupees * 100 - paise) > 1e-6) {
    throw new AppError(409, 'A product in the cart has an invalid price');
  }
  return paise;
}

/** Existing order fields (read by the merchant side) are rupees; paise is exact so /100 is exact to 2 dp. */
export function paiseToRupees(paise: number): number {
  return paise / 100;
}

export interface OrderFees {
  deliveryFeePaise: number;
  platformFeePaise: number;
}

/**
 * Single place to introduce delivery / platform fees later (flat, percentage
 * or distance based). Per owner decision 2026-10-06 there are none for now.
 */
export function computeFees(_subtotalPaise: number): OrderFees {
  return { deliveryFeePaise: 0, platformFeePaise: 0 };
}
