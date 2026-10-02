import type { NextFunction, Response } from 'express';

import { DuoFaceShopService } from '../services/duoFaceShopService';
import type { AuthenticatedRequest } from '../types/auth';

/**
 * Runs after requireRole('merchant'). A resolved merchant principal only
 * carries an opaque shopId — this middleware verifies the shop it actually
 * points to still exists, still belongs to this exact firebaseUid, and is
 * still active. Never repairs a mismatch; a missing/inconsistent/suspended
 * shop is a 403, same as an unmapped identity.
 */
export function requireActiveMerchantShop(shopService: DuoFaceShopService = new DuoFaceShopService()) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const principal = req.principal;

    if (!principal || principal.role !== 'merchant' || !principal.shopId) {
      res.status(403).json({
        error: 'forbidden',
        message: 'An active merchant identity with an assigned shop is required.',
      });
      return;
    }

    let shop;
    try {
      shop = await shopService.getById(principal.shopId);
    } catch (err) {
      console.error(
        'requireActiveMerchantShop: shop lookup failed —',
        err instanceof Error ? err.message : 'unknown error'
      );
      res.status(403).json({ error: 'forbidden', message: 'Merchant shop could not be verified.' });
      return;
    }

    if (!shop || shop.merchantFirebaseUid !== principal.firebaseUid || shop.status !== 'active') {
      res.status(403).json({
        error: 'forbidden',
        message: 'Merchant shop is missing, inconsistent, or suspended.',
      });
      return;
    }

    req.shop = shop;
    next();
  };
}
