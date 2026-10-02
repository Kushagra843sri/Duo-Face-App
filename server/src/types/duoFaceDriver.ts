import { z } from 'zod';

/**
 * Duo-Face-owned driver profile — created and linked by
 * server/src/services/driverProvisioningService.ts, never derived from any
 * Customer App collection (there is no driver concept there). No KYC or
 * bank/payment fields yet — see docs/decisions/013-driver-and-delivery-assignment.md.
 */
export const driverStatusSchema = z.enum(['active', 'suspended']);
export type DriverStatus = z.infer<typeof driverStatusSchema>;

export const duoFaceDriverSchema = z.object({
  driverId: z.string().min(1),
  firebaseUid: z.string().min(1),
  name: z.string().min(1),
  phoneNumber: z.string().min(1).optional(),
  status: driverStatusSchema,
  // The driver activates/deactivates themself (docs/decisions/027). Absent = off duty.
  onDuty: z.boolean().optional(),
  dutyChangedAt: z.unknown().optional(),
  createdAt: z.unknown(),
  updatedAt: z.unknown(),
});

export type DuoFaceDriver = z.infer<typeof duoFaceDriverSchema>;
