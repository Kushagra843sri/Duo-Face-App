import { Router } from 'express';

import { FirebaseAuthService } from '../../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../../integrations/firebase/FirebaseAuthService';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticateFirebase } from '../../middleware/authenticate';
import { requireRole } from '../../middleware/authorize';
import { requireActiveDriver } from '../../middleware/requireActiveDriver';
import { resolveRole } from '../../middleware/resolveRole';
import { validateBody } from '../../middleware/validateBody';
import { DriverLocationService } from '../../services/driverLocationService';
import { DriverService } from '../../services/driverService';
import { getLocationFreshness } from '../../services/locationFreshness';
import { DuoFaceRoleResolver } from '../../services/roleResolver';
import type { RoleResolver } from '../../services/roleResolver';
import type { AuthenticatedRequest } from '../../types/auth';
import { driverLocationInputSchema } from '../../types/driverLocation';
import type { DriverLocation, DriverLocationInput } from '../../types/driverLocation';

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
}

/** Driver's own latest location only; no driverId is ever exposed as an input. */
function toDto(location: DriverLocation) {
  const capturedAt = toIso(location.capturedAt);
  return {
    latitude: location.latitude,
    longitude: location.longitude,
    ...(location.accuracyMeters !== undefined ? { accuracyMeters: location.accuracyMeters } : {}),
    ...(location.heading !== undefined ? { heading: location.heading } : {}),
    ...(location.speedMps !== undefined ? { speedMps: location.speedMps } : {}),
    capturedAt,
    updatedAt: toIso(location.updatedAt),
    freshness: getLocationFreshness(capturedAt ? new Date(capturedAt) : null, new Date()),
  };
}

/**
 * The driver identity always comes from req.driver (verified + active).
 * There is no :driverId segment and no driverId body field (the schema is
 * strict, so one is rejected). Merchants get no access to this data
 * (docs/decisions/019).
 */
export function createDriverLocationRouter(
  verifier: FirebaseIdentityVerifier = new FirebaseAuthService(),
  roleResolver: RoleResolver = new DuoFaceRoleResolver(),
  driverService: DriverService = new DriverService(),
  locationService: DriverLocationService = new DriverLocationService()
) {
  const router = Router();

  const guard = [
    authenticateFirebase(verifier),
    resolveRole(roleResolver),
    requireRole('driver'),
    requireActiveDriver(driverService),
  ];

  router.get(
    '/',
    ...guard,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const location = await locationService.getLatestLocation(req.driver!.driverId);
      if (!location) {
        res.status(404).json({ error: 'not_found', message: 'No location recorded yet.' });
        return;
      }
      res.json(toDto(location));
    })
  );

  router.post(
    '/',
    ...guard,
    validateBody(driverLocationInputSchema),
    asyncHandler(async (req: AuthenticatedRequest, res) => {
      const location = await locationService.updateLocation(req.driver!.driverId, req.body as DriverLocationInput);
      res.json(toDto(location));
    })
  );

  return router;
}
