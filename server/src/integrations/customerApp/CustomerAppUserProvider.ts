/**
 * Resolves identities and merchant/driver relationships that already exist
 * in the Customer App's user store. The exact shape depends on answers in
 * docs/integration/CUSTOMER_APP_REQUIREMENTS.md (Database, Authentication,
 * User/Role Model) — `unknown` return types below are deliberate: no field
 * beyond a bare identifier is confirmed yet.
 */
export interface CustomerAppUserProvider {
  getUserById(userId: string): Promise<CustomerAppUser | null>;
  getMerchantRelationship(userId: string): Promise<unknown | null>;
  getDriverRelationship(userId: string): Promise<unknown | null>;
}

export interface CustomerAppUser {
  id: string;
}
