import type { NextFunction, Response } from 'express';

import type { AuthenticatedRequest, Role } from '../types/auth';

/**
 * Distinct from middleware/resolveRole.ts: resolveRole answers "does this
 * identity have any application role at all" (403 if not, and attaches
 * req.principal if so); this answers "is that role the right one for this
 * specific route." Must run after resolveRole().
 */
export function requireRole(...roles: Role[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.principal || !roles.includes(req.principal.role)) {
      res.status(403).json({
        error: 'forbidden',
        message: `This route requires one of these roles: ${roles.join(', ')}.`,
      });
      return;
    }

    next();
  };
}
