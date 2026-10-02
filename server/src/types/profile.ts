import { z } from 'zod';

import {
  isAdultDob,
  isFutureDate,
  isValidAadhaar,
  isValidBankAccount,
  isValidFssai,
  isValidGstin,
  isValidIfsc,
  isValidLicenceNumber,
  isValidPan,
  isValidPhone,
  isValidPincode,
  isValidUpi,
  isValidVehicleNumber,
  normalizeAadhaar,
  normalizeUpper,
} from '../validators/indianIds';

export const DRIVER_PROFILES_COLLECTION = 'duo_face_driver_profiles';
export const MERCHANT_PROFILES_COLLECTION = 'duo_face_merchant_profiles';

/**
 * Server-owned. A client can never set these (every input schema below is
 * `.strict()`); only the services — and later an admin tool via
 * ProfileVerificationService — move them.
 */
export const verificationStatusSchema = z.enum(['incomplete', 'pending_review', 'verified', 'rejected']);
export type VerificationStatus = z.infer<typeof verificationStatusSchema>;

const text = (min: number, max: number, label: string) =>
  z
    .string({ required_error: `${label} is required.` })
    .trim()
    .min(min, `${label} is required.`)
    .max(max, `${label} is too long.`);

const phone = (label: string) => z.string().trim().refine(isValidPhone, `${label} must include the country code, e.g. +919876543210.`);

export const addressInputSchema = z
  .object({
    line1: text(3, 120, 'Address'),
    city: text(2, 60, 'City'),
    state: text(2, 60, 'State').optional(),
    pincode: z.string().trim().refine(isValidPincode, 'Enter a valid 6-digit pincode.'),
  })
  .strict();

const upi = z.string().trim().refine(isValidUpi, 'Enter a valid UPI id, e.g. name@bank.');

/** Sensitive values are optional on update: omit to keep what is stored (the app only ever shows them masked). */
export const bankInputSchema = z
  .object({
    accountHolderName: text(2, 80, 'Account holder name'),
    accountNumber: z.string().trim().refine(isValidBankAccount, 'Account number must be 9-18 digits.').optional(),
    ifsc: z.string().trim().refine(isValidIfsc, 'Enter a valid IFSC, e.g. SBIN0001234.'),
    bankName: text(2, 80, 'Bank name').optional(),
    upiId: upi.optional(),
  })
  .strict();

export const driverProfileInputSchema = z
  .object({
    personal: z
      .object({
        fullName: text(2, 80, 'Full name'),
        contactPhone: phone('Phone number'),
        dateOfBirth: z.string().trim().refine((v) => isAdultDob(v), 'You must be at least 18 (use YYYY-MM-DD).'),
        address: addressInputSchema,
        emergencyContact: z.object({ name: text(2, 80, 'Emergency contact name'), phone: phone('Emergency contact phone') }).strict(),
      })
      .strict()
      .optional(),
    identity: z
      .object({
        aadhaarNumber: z.string().trim().refine(isValidAadhaar, 'Enter a valid 12-digit Aadhaar number.').optional(),
        panNumber: z.string().trim().refine(isValidPan, 'Enter a valid PAN, e.g. ABCDE1234F.').optional(),
        licenceNumber: z.string().trim().refine(isValidLicenceNumber, 'Enter a valid driving licence number.').optional(),
        licenceExpiry: z.string().trim().refine((v) => isFutureDate(v), 'Licence expiry must be a future date (YYYY-MM-DD).').optional(),
      })
      .strict()
      .optional(),
    vehicle: z
      .object({
        type: z.enum(['bicycle', 'scooter', 'motorcycle', 'ev', 'car']),
        registrationNumber: z.string().trim().refine(isValidVehicleNumber, 'Enter a valid vehicle number, e.g. DL1AB1234.'),
        makeModel: text(2, 60, 'Make / model').optional(),
      })
      .strict()
      .optional(),
    bank: bankInputSchema.optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update.');
export type DriverProfileInput = z.infer<typeof driverProfileInputSchema>;

export const merchantProfileInputSchema = z
  .object({
    personal: z
      .object({
        shopName: text(2, 80, 'Shop name'),
        ownerName: text(2, 80, 'Owner name'),
        contactPhone: phone('Phone number'),
        email: z.string().trim().email('Enter a valid email.').max(120).optional(),
        address: addressInputSchema,
      })
      .strict()
      .optional(),
    identity: z
      .object({
        panNumber: z.string().trim().refine(isValidPan, 'Enter a valid PAN, e.g. ABCDE1234F.').optional(),
        gstin: z.string().trim().refine(isValidGstin, 'Enter a valid 15-character GSTIN.').optional(),
        fssai: z.string().trim().refine(isValidFssai, 'FSSAI number is 14 digits.').optional(),
      })
      .strict()
      .optional(),
    bank: bankInputSchema.optional(),
    /** Where drivers collect orders (decision 026): the app sends the phone's current position. */
    pickupLocation: z
      .object({
        latitude: z.number().finite().min(-90).max(90),
        longitude: z.number().finite().min(-180).max(180),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, 'Nothing to update.');
export type MerchantProfileInput = z.infer<typeof merchantProfileInputSchema>;

export const PHOTO_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_PHOTO_BYTES = 5 * 1024 * 1024;

const photoUploadBase = {
  contentType: z.enum(PHOTO_CONTENT_TYPES),
  sizeBytes: z.number().int().min(1).max(MAX_PHOTO_BYTES),
};
export const driverPhotoKindSchema = z.enum(['selfie', 'vehicle']);
export const merchantPhotoKindSchema = z.enum(['shop']);
export const driverPhotoUploadSchema = z.object({ kind: driverPhotoKindSchema, ...photoUploadBase }).strict();
export const merchantPhotoUploadSchema = z.object({ kind: merchantPhotoKindSchema, ...photoUploadBase }).strict();
export const driverPhotoConfirmSchema = z.object({ kind: driverPhotoKindSchema, objectKey: z.string().min(1).max(300) }).strict();
export const merchantPhotoConfirmSchema = z.object({ kind: merchantPhotoKindSchema, objectKey: z.string().min(1).max(300) }).strict();

export { normalizeAadhaar, normalizeUpper };

/** Section row for the app's completeness card. */
export interface CompletenessSection {
  key: string;
  label: string;
  done: boolean;
  optional?: boolean;
}

export interface Completeness {
  sections: CompletenessSection[];
  completed: number;
  total: number;
}

export function buildCompleteness(sections: CompletenessSection[]): Completeness {
  const required = sections.filter((s) => !s.optional);
  return { sections, completed: required.filter((s) => s.done).length, total: required.length };
}
