/**
 * Resolves identities that already exist in the Customer App's user store.
 * The exact shape depends on answers in
 * docs/integration/CUSTOMER_APP_REQUIREMENTS.md (Database, Authentication).
 */
export interface CustomerAppUserProvider {
  getUserById(userId: string): Promise<CustomerAppUser | null>;
}

export interface CustomerAppUser {
  id: string;
  phone: string;
}
