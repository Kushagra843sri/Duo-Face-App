import { z } from 'zod';

/**
 * Duo-Face-owned identity mapping: firebaseUid -> merchant/driver role.
 * The Customer App has no role concept at all (see
 * docs/decisions/005-identity-and-role-mapping.md), so this is the source
 * of truth for it — stored in the Duo-Face-owned `duo_face_identities`
 * Firestore collection, never in a Customer App collection.
 */
export const identityStatusSchema = z.enum(['active', 'suspended']);
export type IdentityStatus = z.infer<typeof identityStatusSchema>;

export const duoFaceIdentitySchema = z
  .object({
    firebaseUid: z.string().min(1),
    role: z.enum(['merchant', 'driver']),
    status: identityStatusSchema,
    merchant: z.object({ shopId: z.string().min(1) }).optional(),
    driver: z.object({ driverId: z.string().min(1) }).optional(),
    createdAt: z.unknown(),
    updatedAt: z.unknown(),
  })
  .superRefine((identity, ctx) => {
    if (identity.role === 'merchant') {
      if (!identity.merchant?.shopId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Merchant identity is missing merchant.shopId' });
      }
      if (identity.driver) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Merchant identity must not also have a driver mapping',
        });
      }
    }

    if (identity.role === 'driver') {
      if (!identity.driver?.driverId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Driver identity is missing driver.driverId' });
      }
      if (identity.merchant) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Driver identity must not also have a merchant mapping',
        });
      }
    }
  });

export type DuoFaceIdentity = z.infer<typeof duoFaceIdentitySchema>;
