import type { OrderFulfillmentStatus } from '../types/customerAppOrder';

/**
 * The only place that says which order status may follow which. Every status
 * write (customer cancel, merchant accept/reject/prepare, delivery) must call
 * assertTransition first and record an `order_events` entry (buildOrderEvent).
 */
export const ALLOWED_TRANSITIONS: Record<OrderFulfillmentStatus, readonly OrderFulfillmentStatus[]> = {
  pending: ['confirmed', 'rejected', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready_for_pickup', 'cancelled'],
  ready_for_pickup: ['out_for_delivery', 'cancelled'],
  out_for_delivery: ['delivered'],
  delivered: [],
  cancelled: [],
  rejected: [],
};

export type OrderActor = { type: 'customer' | 'merchant' | 'driver' | 'system'; id: string };

export class InvalidOrderTransitionError extends Error {
  constructor(
    readonly from: OrderFulfillmentStatus,
    readonly to: OrderFulfillmentStatus
  ) {
    super(`Order cannot move from ${from} to ${to}`);
    this.name = 'InvalidOrderTransitionError';
  }
}

export function canTransition(from: OrderFulfillmentStatus, to: OrderFulfillmentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderFulfillmentStatus, to: OrderFulfillmentStatus): void {
  if (!canTransition(from, to)) throw new InvalidOrderTransitionError(from, to);
}

/** Terminal statuses never change again. */
export function isTerminal(status: OrderFulfillmentStatus): boolean {
  return ALLOWED_TRANSITIONS[status].length === 0;
}

export interface OrderEvent {
  orderId: string;
  shopId: string;
  from: OrderFulfillmentStatus | null; // null for the creation event
  to: OrderFulfillmentStatus;
  actor: OrderActor;
  createdAt: Date;
}

export function buildOrderEvent(
  orderId: string,
  shopId: string,
  from: OrderFulfillmentStatus | null,
  to: OrderFulfillmentStatus,
  actor: OrderActor,
  now: Date
): OrderEvent {
  return { orderId, shopId, from, to, actor, createdAt: now };
}
