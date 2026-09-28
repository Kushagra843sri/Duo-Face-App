/**
 * Reads and updates orders that live in the Customer App's database. Order
 * lifecycle, status values and ownership model are unconfirmed — see
 * docs/integration/CUSTOMER_APP_REQUIREMENTS.md (Orders).
 */
export interface CustomerAppOrderProvider {
  getOrderById(orderId: string): Promise<CustomerAppOrder | null>;
}

export interface CustomerAppOrder {
  id: string;
  status: string;
}
