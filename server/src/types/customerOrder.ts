import { z } from 'zod';

const phone = z.string().regex(/^\+?\d{10,13}$/, 'phoneNumber must be 10-13 digits');

export const addressBodySchema = z
  .object({
    label: z.string().trim().min(1).max(40),
    fullAddress: z.string().trim().min(5).max(300),
    phoneNumber: phone,
    isDefault: z.boolean().optional(),
    latitude: z.number().min(-90).max(90).optional(),
    longitude: z.number().min(-180).max(180).optional(),
  })
  .strict()
  .refine((a) => (a.latitude === undefined) === (a.longitude === undefined), {
    message: 'latitude and longitude must be sent together',
  });
export type AddressBody = z.infer<typeof addressBodySchema>;

export const addressPatchSchema = z
  .object({
    label: z.string().trim().min(1).max(40),
    fullAddress: z.string().trim().min(5).max(300),
    phoneNumber: phone,
    isDefault: z.boolean(),
  })
  .partial()
  .strict()
  .refine((a) => Object.keys(a).length > 0, { message: 'Nothing to update' });
export type AddressPatch = z.infer<typeof addressPatchSchema>;

export const placeOrderBodySchema = z
  .object({
    /** Client-generated per checkout attempt; makes a retried/double-tapped request idempotent. */
    clientRequestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    shopId: z.string().min(1),
    addressId: z.string().min(1),
    paymentMethod: z.enum(['cod', 'online']),
    items: z
      .array(z.object({ productId: z.string().min(1), quantity: z.number().int().min(1).max(50) }).strict())
      .min(1)
      .max(30),
  })
  .strict();
export type PlaceOrderBody = z.infer<typeof placeOrderBodySchema>;

export interface CustomerAddress {
  addressId: string;
  label: string;
  fullAddress: string;
  phoneNumber: string;
  isDefault: boolean;
  latitude?: number;
  longitude?: number;
}

export interface CustomerShopView {
  shopId: string;
  name: string;
  address: string;
  imageUrl: string | null;
  /** Storefront photos the owner uploaded (up to 4, first = cover), so customers recognise the shop by sight. */
  images: string[];
  rating: number | null;
  isOpen: boolean;
}

export interface CustomerProductView {
  productId: string;
  name: string;
  description: string | null;
  imageUrl: string | null;
  pricePaise: number;
  available: number;
}

/** Customer-facing order view. Money is integer paise; no internal fields. */
export interface CustomerOrderView {
  orderId: string;
  shopId: string;
  shopName: string;
  status: string;
  paymentMethod: string;
  paymentStatus: string;
  items: { productId: string; name: string; quantity: number; pricePaise: number; subtotalPaise: number }[];
  delivery: { label: string; fullAddress: string; phoneNumber: string };
  pricing: { subtotalPaise: number; deliveryFeePaise: number; platformFeePaise: number; totalPaise: number };
  createdAt: string | null;
  /** Online orders only: the unpaid order is cancelled (stock released) after this time. */
  paymentExpiresAt: string | null;
}
