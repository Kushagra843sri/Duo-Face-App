import type { NextFunction, Request, Response } from 'express';

import type { AuthenticatedPrincipal, Role } from '../types/auth';

export interface AuthenticatedRequest extends Request {
  principal?: AuthenticatedPrincipal;
}

/**
 * TODO(auth): the Customer App's JWT issuer, signing/verification method and
 * claims shape are unconfirmed — see docs/integration/CUSTOMER_APP_REQUIREMENTS.md.
 * This stub deliberately never authenticates anyone; it fixes the
 * routes -> requireRole() -> service call shape ahead of time so no route
 * accidentally trusts a client-supplied role once real auth lands.
 */
export function requireRole(..._roles: Role[]) {
  return (_req: AuthenticatedRequest, res: Response, _next: NextFunction) => {
    res.status(501).json({
      error: 'not_implemented',
      message:
        'Authentication is not implemented yet — see docs/integration/CUSTOMER_APP_REQUIREMENTS.md',
    });
  };
}
