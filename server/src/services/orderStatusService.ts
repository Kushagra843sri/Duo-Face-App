import { FirestoreCustomerStore } from '../integrations/firebase/FirestoreCustomerStore';
import type { CheckoutTx, CustomerStore } from '../integrations/firebase/FirestoreCustomerStore';
import { AppError } from '../middleware/errorHandler';
import { orderFulfillmentStatusSchema } from '../types/customerAppOrder';
import type { OrderFulfillmentStatus } from '../types/customerAppOrder';
import { buildInventoryId } from '../types/inventoryItem';
import { assertTransition, buildOrderEvent, InvalidOrderTransitionError } from './orderState';
import type { OrderActor } from './orderState';

type Doc = Record<string, unknown>;

export const INVENTORY_COLLECTION = 'duo_face_inventory';

/** Statuses after which the reserved stock goes back on the shelf. */
const RESTOCKING: readonly OrderFulfillmentStatus[] = ['cancelled', 'rejected'];

/** Forward path used when a pickup has physically happened ahead of the merchant's status updates. */
const FORWARD_PATH: readonly OrderFulfillmentStatus[] = [
  'pending',
  'confirmed',
  'preparing',
  'ready_for_pickup',
  'out_for_delivery',
];

/**
 * Put an order's quantities back into inventory. Must be called inside a
 * transaction callback; reads happen now, writes are buffered by `tx`.
 */
export async function restoreStock(tx: CheckoutTx, shopId: string, items: Doc[], now: Date): Promise<void> {
  const rows: { productId: string; qty: number; doc: Doc | null }[] = [];
  for (const item of items) {
    const productId = String(item.productId);
    rows.push({ productId, qty: Number(item.quantity), doc: await tx.get(INVENTORY_COLLECTION, buildInventoryId(shopId, productId)) });
  }
  for (const r of rows) {
    if (!r.doc) continue; // inventory record removed meanwhile: nothing to restore into
    tx.set(INVENTORY_COLLECTION, buildInventoryId(shopId, r.productId), {
      ...r.doc,
      quantity: Number(r.doc.quantity) + r.qty,
      updatedAt: now,
    });
  }
}

function parseStatus(raw: Doc): OrderFulfillmentStatus {
  const parsed = orderFulfillmentStatusSchema.safeParse(raw.status);
  if (!parsed.success) throw new AppError(409, 'Order is in an unknown state');
  return parsed.data;
}

/**
 * Status writes for merchant and delivery events. Each runs in one Firestore
 * transaction: the order is re-read, must belong to `shopId`, the move must
 * be allowed by orderState, and an `order_events` row is written per step.
 * A repeat of the status the order already has is a no-op (idempotent).
 */
export class OrderStatusService {
  constructor(
    private readonly store: CustomerStore = new FirestoreCustomerStore(),
    private readonly now: () => Date = () => new Date()
  ) {}

  async transition(orderId: string, shopId: string, to: OrderFulfillmentStatus, actor: OrderActor): Promise<OrderFulfillmentStatus> {
    return this.store.runTransaction(async (tx) => {
      const raw = await this.loadOwned(tx, orderId, shopId);
      const from = parseStatus(raw);
      if (from === to) return to;
      try {
        assertTransition(from, to);
      } catch (err) {
        if (err instanceof InvalidOrderTransitionError) throw new AppError(409, `Order cannot move from ${from} to ${to}`);
        throw err;
      }
      const now = this.now();
      await this.apply(tx, orderId, shopId, raw, [[from, to]], actor, now);
      return to;
    });
  }

  /**
   * A driver has picked the order up. Walk it forward through every
   * remaining allowed step to `out_for_delivery`, recording each. Orders that
   * are already out for delivery/delivered are left alone; cancelled/rejected
   * ones are never revived (409).
   */
  async markOutForDelivery(orderId: string, shopId: string, actor: OrderActor): Promise<OrderFulfillmentStatus> {
    return this.store.runTransaction(async (tx) => {
      const raw = await this.loadOwned(tx, orderId, shopId);
      const from = parseStatus(raw);
      if (from === 'out_for_delivery' || from === 'delivered') return from;
      const start = FORWARD_PATH.indexOf(from);
      if (start < 0) throw new AppError(409, `Order is ${from} and cannot be picked up`);

      const steps: [OrderFulfillmentStatus, OrderFulfillmentStatus][] = [];
      for (let i = start; i < FORWARD_PATH.length - 1; i++) {
        assertTransition(FORWARD_PATH[i], FORWARD_PATH[i + 1]);
        steps.push([FORWARD_PATH[i], FORWARD_PATH[i + 1]]);
      }
      await this.apply(tx, orderId, shopId, raw, steps, actor, this.now());
      return 'out_for_delivery';
    });
  }

  private async loadOwned(tx: CheckoutTx, orderId: string, shopId: string): Promise<Doc> {
    const raw = await tx.get('orders', orderId);
    // Missing and another shop's order are indistinguishable.
    if (!raw || raw.shopId !== shopId) throw new AppError(404, 'Order not found');
    return raw;
  }

  private async apply(
    tx: CheckoutTx,
    orderId: string,
    shopId: string,
    raw: Doc,
    steps: [OrderFulfillmentStatus, OrderFulfillmentStatus][],
    actor: OrderActor,
    now: Date
  ): Promise<void> {
    const finalStatus = steps[steps.length - 1][1];
    if (RESTOCKING.includes(finalStatus)) {
      await restoreStock(tx, shopId, Array.isArray(raw.items) ? (raw.items as Doc[]) : [], now);
    }
    tx.set('orders', orderId, {
      ...raw,
      status: finalStatus,
      updatedAt: now,
      ...(finalStatus === 'cancelled' ? { cancelledAt: now } : {}),
      ...(finalStatus === 'rejected' ? { rejectedAt: now } : {}),
    });
    for (const [from, to] of steps) {
      tx.set('order_events', `${orderId}__${from}_${to}`, { ...buildOrderEvent(orderId, shopId, from, to, actor, now) });
    }
  }
}
