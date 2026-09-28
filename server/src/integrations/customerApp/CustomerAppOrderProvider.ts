/**
 * Reads and updates orders that live in the Customer App's database. Order
 * lifecycle, status values and ownership model are unconfirmed — see
 * docs/integration/CUSTOMER_APP_REQUIREMENTS.md (Orders). `onOrderChanged` is
 * optional because whether the Customer App owns a realtime layer at all is
 * itself unconfirmed (see Realtime Events in the same doc).
 */
export interface CustomerAppOrderProvider {
  getOrderById(orderId: string): Promise<CustomerAppOrder | null>;
  updateOrderStatus(orderId: string, status: string): Promise<CustomerAppOrder>;
  onOrderChanged?(listener: (order: CustomerAppOrder) => void): () => void;
}

export interface CustomerAppOrder {
  id: string;
  status: string;
}
