import { z } from 'zod';

/**
 * Duo-Face-owned shop entity — created and linked by
 * server/src/services/merchantProvisioningService.ts, never derived from
 * the Customer App's `shops` collection (see
 * docs/decisions/007-merchant-shop-boundary.md). One shop has one
 * merchant owner for now.
 */
export const shopStatusSchema = z.enum(['active', 'suspended']);
export type ShopStatus = z.infer<typeof shopStatusSchema>;

export const pickupLocationSchema = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
});
export type PickupLocation = z.infer<typeof pickupLocationSchema>;

export const duoFaceShopSchema = z.object({
  shopId: z.string().min(1),
  name: z.string().min(1),
  status: shopStatusSchema,
  merchantFirebaseUid: z.string().min(1),
  // Optional: the Customer App's own shop id (products.shopId references
  // this, NOT `shopId` above — see docs/decisions/009-merchant-product-catalog-boundary.md).
  // Nullable/absent until a provisioning flow supplies and validates one.
  customerAppShopId: z.string().min(1).optional(),
  // Where drivers collect orders — the origin for nearest-driver dispatch
  // (docs/decisions/026). Duo-Face-owned and additive: the Customer App shop
  // has only a text address. Absent => dispatch geocodes that address.
  pickupLocation: pickupLocationSchema.optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
});

export type DuoFaceShop = z.infer<typeof duoFaceShopSchema>;
