import type { NextFunction, Response } from 'express';

import { DriverService } from '../services/driverService';
import type { AuthenticatedRequest } from '../types/auth';

/**
 * Runs after requireRole('driver'). A resolved driver principal only
 * carries an opaque driverId — this middleware verifies the driver it
 * actually points to still exists, still belongs to this exact
 * firebaseUid, and is still active. Never repairs a mismatch; a
 * missing/inconsistent/suspended driver is a 403, same as an unmapped
 * identity. Mirrors middleware/requireActiveMerchantShop.ts.
 */
export function requireActiveDriver(driverService: DriverService = new DriverService()) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const principal = req.principal;

    if (!principal || principal.role !== 'driver' || !principal.driverId) {
      res.status(403).json({
        error: 'forbidden',
        message: 'An active driver identity with an assigned driver profile is required.',
      });
      return;
    }

    let driver;
    try {
      driver = await driverService.getById(principal.driverId);
    } catch (err) {
      console.error(
        'requireActiveDriver: driver lookup failed —',
        err instanceof Error ? err.message : 'unknown error'
      );
      res.status(403).json({ error: 'forbidden', message: 'Driver profile could not be verified.' });
      return;
    }

    if (!driver || driver.firebaseUid !== principal.firebaseUid || driver.status !== 'active') {
      res.status(403).json({
        error: 'forbidden',
        message: 'Driver profile is missing, inconsistent, or suspended.',
      });
      return;
    }

    req.driver = driver;
    next();
  };
}
