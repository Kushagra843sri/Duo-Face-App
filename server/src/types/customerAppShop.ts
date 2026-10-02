import { z } from 'zod';

/**
 * Only the minimum fields needed to verify a Customer App shop genuinely
 * exists (see docs/decisions/009-merchant-product-catalog-boundary.md) —
 * not the full document (address, imageUrl, rating, isOpen, isActive,
 * createdAt are intentionally omitted). Confirmed from source:
 * customer_app/lib/features/shops/models/shop.dart.
 */
export const customerAppShopSnapshotSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

export type CustomerAppShopSnapshot = z.infer<typeof customerAppShopSnapshotSchema>;
