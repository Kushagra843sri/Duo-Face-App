import { z } from 'zod';

/**
 * Body of POST /driver/location. `.strict()` so a client-supplied
 * `driverId` (or any other unknown key) is rejected with 400 rather than
 * silently ignored. Timestamps are never client input.
 */
export const driverLocationInputSchema = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
    accuracyMeters: z.number().finite().min(0).optional(),
    heading: z.number().finite().min(0).max(360).optional(),
    speedMps: z.number().finite().min(0).optional(),
  })
  .strict();

export type DriverLocationInput = z.infer<typeof driverLocationInputSchema>;

/**
 * duo_face_driver_locations/{driverId} — the driver's latest position only.
 * Deliberately no firebaseUid, order, customer, address or payment data.
 * `capturedAt`/`updatedAt` are set by the server.
 */
export const driverLocationSchema = z.object({
  driverId: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracyMeters: z.number().min(0).optional(),
  heading: z.number().min(0).max(360).optional(),
  speedMps: z.number().min(0).optional(),
  capturedAt: z.unknown(),
  updatedAt: z.unknown(),
});

export type DriverLocation = z.infer<typeof driverLocationSchema>;
