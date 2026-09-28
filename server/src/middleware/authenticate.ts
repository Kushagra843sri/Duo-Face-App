import type { NextFunction, Request, Response } from 'express';

import { FirebaseAuthService } from '../integrations/firebase/FirebaseAuthService';
import type { FirebaseIdentityVerifier } from '../integrations/firebase/FirebaseAuthService';
import type { AuthenticatedRequest } from '../types/auth';

const BEARER_PREFIX = 'Bearer ';

/**
 * Verifies a Firebase ID token and attaches only the verified identity to the
 * request. This is authentication, not authorization — it never reads or
 * attaches role/storeId/driverId from anywhere (body, query, headers), and
 * never trusts a role the client claims. See middleware/authorize.ts for the
 * separate, still-unimplemented authorization boundary.
 */
export function authenticateFirebase(verifier: FirebaseIdentityVerifier = new FirebaseAuthService()) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;

    if (!header || !header.startsWith(BEARER_PREFIX)) {
      res.status(401).json({
        error: 'unauthenticated',
        message: 'Missing or malformed Authorization header. Expected: Bearer <Firebase ID token>.',
      });
      return;
    }

    const token = header.slice(BEARER_PREFIX.length).trim();
    if (!token) {
      res.status(401).json({ error: 'unauthenticated', message: 'Missing bearer token.' });
      return;
    }

    try {
      const identity = await verifier.verifyIdToken(token);
      (req as AuthenticatedRequest).identity = identity;
      next();
    } catch (err) {
      // Log only the error message server-side (useful for spotting a
      // configuration problem, e.g. missing FIREBASE_PROJECT_ID) — never the
      // token itself, and the client always gets the same generic response
      // regardless of whether the cause was misconfiguration or a bad token.
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('authenticateFirebase: token verification failed —', message);
      res.status(401).json({ error: 'unauthenticated', message: 'Invalid or expired Firebase ID token.' });
    }
  };
}
