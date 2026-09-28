import type { CustomerAppAuthProvider } from './CustomerAppAuthProvider';
import type { CustomerAppInventoryProvider } from './CustomerAppInventoryProvider';
import type { CustomerAppOrderProvider } from './CustomerAppOrderProvider';
import type { CustomerAppUserProvider } from './CustomerAppUserProvider';

/**
 * The full set of capabilities Duo-Face needs from the existing Customer App.
 * No concrete implementation exists yet — database engine, API contract and
 * auth system are all unconfirmed (docs/integration/CUSTOMER_APP_REQUIREMENTS.md).
 * A real adapter (DB-backed or HTTP-backed) is a later phase's work. Role is
 * intentionally absent from this surface — see CustomerAppAuthProvider.
 */
export interface CustomerAppClient {
  auth: CustomerAppAuthProvider;
  users: CustomerAppUserProvider;
  orders: CustomerAppOrderProvider;
  inventory: CustomerAppInventoryProvider;
}
