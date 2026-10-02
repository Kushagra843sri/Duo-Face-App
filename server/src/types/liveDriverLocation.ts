/**
 * The live (ephemeral, Redis) position of a driver. Keyed by driverId —
 * never a Firebase UID. `assignmentId` is the opaque id of the one active
 * assignment being tracked (used only to refuse serving a position that
 * belongs to a different assignment); no customer, order or address data.
 */
export interface LiveDriverLocation {
  driverId: string;
  assignmentId: string;
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  heading?: number;
  speedMps?: number;
  capturedAt: Date;
}
