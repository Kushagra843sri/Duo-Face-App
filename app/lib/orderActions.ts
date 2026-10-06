import type { MerchantOrderAction } from '@/api/merchant';

export interface OrderActionOption {
  status: MerchantOrderAction;
  label: string;
  /** Rejecting is final and tells the customer: it asks for confirmation. */
  destructive?: boolean;
}

/**
 * What the shop can do next with an order, in order. This mirrors the
 * server's transition map (the server is the authority and refuses anything
 * else with a 409), so the app only ever offers sensible next steps.
 */
export function nextActions(status: string): OrderActionOption[] {
  switch (status) {
    case 'pending':
      return [
        { status: 'confirmed', label: 'Accept order' },
        { status: 'rejected', label: 'Reject order', destructive: true },
      ];
    case 'confirmed':
      return [{ status: 'preparing', label: 'Start preparing' }];
    case 'preparing':
      return [{ status: 'ready_for_pickup', label: 'Mark ready for pickup' }];
    default:
      return [];
  }
}

/** One line telling the shop what is expected of them right now. */
export function nextStepHint(status: string): string | null {
  switch (status) {
    case 'pending':
      return 'New order: accept it to start, or reject it if you cannot fulfil it.';
    case 'confirmed':
      return 'Accepted. Start preparing when you begin packing.';
    case 'preparing':
      return 'Mark it ready when the order is packed, then request a delivery partner.';
    case 'ready_for_pickup':
      return 'Ready. Request a delivery partner below if you have not yet.';
    default:
      return null;
  }
}
