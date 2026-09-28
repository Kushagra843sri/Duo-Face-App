import type { CustomerAppUser } from './CustomerAppUserProvider';

/**
 * Verifies credentials/tokens issued by the Customer App's existing auth
 * system and returns the underlying identity. Issuer, signing method and
 * token format are unconfirmed — see docs/integration/CUSTOMER_APP_REQUIREMENTS.md
 * (Authentication). Role is deliberately not part of this contract: it's a
 * Duo-Face-owned concept (server/src/types/auth.ts) resolved from Duo-Face's
 * own data once that exists, not something the Customer App is assumed to know.
 */
export interface CustomerAppAuthProvider {
  verifyToken(token: string): Promise<CustomerAppUser | null>;
}
