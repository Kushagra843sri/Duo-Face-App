import type { NextFunction, Response } from 'express';

import type { AuthenticatedRequest, Role } from '../types/auth';

/**
 * Distinct from middleware/resolveRole.ts: resolveRole answers "does this
 * identity have any application role at all" (403 if not); this answers "is
 * that role the right one for this specific route." No route can use this
 * for real yet because no merchant/driver role mapping exists in the
 * Customer App — confirmed by source review, see
 * docs/decisions/005-identity-and-role-mapping.md. Not mounted on any route.
 */
export function requireRole(..._roles: Role[]) {
  return (_req: AuthenticatedRequest, res: Response, _next: NextFunction) => {
    res.status(501).json({
      error: 'not_implemented',
      message: 'Role authorization is not implemented yet — see server/src/services/roleResolver.ts',
    });
  };
}
