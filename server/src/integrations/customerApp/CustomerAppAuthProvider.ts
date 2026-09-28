import type { CustomerAppUser } from './CustomerAppUserProvider';

/**
 * Verifies credentials/tokens issued by the Customer App's existing auth
 * system. Issuer, signing method and token format are unconfirmed — see
 * docs/integration/CUSTOMER_APP_REQUIREMENTS.md (Authentication).
 */
export interface CustomerAppAuthProvider {
  verifyToken(token: string): Promise<CustomerAppUser | null>;
}
