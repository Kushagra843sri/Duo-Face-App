/**
 * Reads orders that live in the Customer App's database, and performs ONE
 * narrow write: marking an order delivered (docs/decisions/024).
 *
 * `getOrderById`/`listOrdersByShopId` return `unknown` deliberately — no
 * field shape is assumed here; validation happens at the point of use.
 *
 * There is intentionally NO generic "update status" method: callers cannot
 * supply a target status. The target ('delivered') and the only permitted
 * source status ('out_for_delivery') are fixed inside markOrderDelivered.
 * Only CustomerOrderSyncService may call it.
 */
export interface CustomerAppOrderProvider {
  listOrdersByShopId(shopId: string): Promise<unknown[]>;
  getOrderById(orderId: string): Promise<unknown | null>;
  markOrderDelivered(orderId: string, expectedShopId: string): Promise<MarkOrderDeliveredOutcome>;
}

/**
 * Structured result of markOrderDelivered. External failures are NOT an
 * outcome: they are thrown as CustomerAppUnavailableError (categorized,
 * message-free of internals).
 */
export type MarkOrderDeliveredOutcome =
  | { kind: 'completed' } // out_for_delivery -> delivered was written
  | { kind: 'already_delivered' } // nothing written
  | { kind: 'protected_status'; status: string } // cancelled / rejected / anything else: nothing written
  | { kind: 'not_found' }
  | { kind: 'shop_mismatch' };

/** Safe, categorized external failure. Carries no Firestore message, path or credentials. */
export class CustomerAppUnavailableError extends Error {
  constructor(readonly category: 'transient' | 'permanent') {
    super(`customer app order store ${category} failure`);
    this.name = 'CustomerAppUnavailableError';
  }
}
