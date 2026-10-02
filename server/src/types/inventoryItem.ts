import { z } from 'zod';

/**
 * Duo-Face-owned inventory quantity for a merchant's shop/product pair.
 * The Customer App's `products.inStock` boolean is untouched and remains
 * the existing availability signal (see
 * docs/decisions/008-merchant-inventory-boundary.md); this is a separate,
 * new concept, not a field bolted onto that document.
 */
export const inventoryStatusSchema = z.enum(['active', 'disabled']);
export type InventoryStatus = z.infer<typeof inventoryStatusSchema>;

export const inventoryItemSchema = z
  .object({
    inventoryId: z.string().min(1),
    shopId: z.string().min(1),
    productId: z.string().min(1),
    quantity: z.number().int().min(0),
    reservedQuantity: z.number().int().min(0),
    status: inventoryStatusSchema,
    createdAt: z.unknown(),
    updatedAt: z.unknown(),
  })
  .superRefine((item, ctx) => {
    if (item.reservedQuantity > item.quantity) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'reservedQuantity cannot exceed quantity' });
    }
  });

export type InventoryItem = z.infer<typeof inventoryItemSchema>;

/** Deterministic — one shop cannot accidentally have two records for the same product. */
export function buildInventoryId(shopId: string, productId: string): string {
  return `${shopId}__${productId}`;
}
