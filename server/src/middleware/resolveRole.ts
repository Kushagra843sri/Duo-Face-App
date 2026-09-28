import type { NextFunction, Response } from 'express';

import type { RoleResolver } from '../services/roleResolver';
import { DuoFaceRoleResolver } from '../services/roleResolver';
import type { AuthenticatedRequest } from '../types/auth';

/**
 * Sits between authenticateFirebase() and requireRole(): resolves the
 * verified Firebase identity to an AuthenticatedPrincipal via RoleResolver.
 * Responds 403 (not 401 — the identity itself is valid, it's just unmapped)
 * when no role mapping exists, rather than calling next() with no principal.
 */
export function resolveRole(roleResolver: RoleResolver = new DuoFaceRoleResolver()) {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.identity) {
      // Programmer error if reached: resolveRole() must run after authenticateFirebase().
      res.status(401).json({ error: 'unauthenticated', message: 'No verified identity to resolve a role for.' });
      return;
    }

    const principal = await roleResolver.resolve(req.identity.firebaseUid);
    if (!principal) {
      res.status(403).json({
        error: 'role_unresolved',
        message: 'This Firebase identity has no mapped merchant/driver role yet.',
      });
      return;
    }

    req.principal = principal;
    next();
  };
}
