import { z } from 'zod';

/**
 * Only the fields the merchant catalog actually needs, from the subset of
 * the Customer App's `products` schema confirmed by direct source review
 * (customer_app/lib/features/products/models/product.dart) — not the full
 * document (categoryId, description, imageUrl, isActive, createdAt are
 * intentionally omitted). A product missing any of these is treated as
 * malformed and skipped by the caller, never repaired or guessed.
 */
export const customerAppProductSnapshotSchema = z.object({
  id: z.string().min(1),
  shopId: z.string().min(1),
  name: z.string().min(1),
  price: z.number(),
  inStock: z.boolean(),
});

export type CustomerAppProductSnapshot = z.infer<typeof customerAppProductSnapshotSchema>;
