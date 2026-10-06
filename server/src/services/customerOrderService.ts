import { FirestoreCustomerStore } from '../integrations/firebase/FirestoreCustomerStore';
import type { CheckoutTx, CustomerStore } from '../integrations/firebase/FirestoreCustomerStore';
import { AppError } from '../middleware/errorHandler';
import { buildInventoryId, inventoryItemSchema } from '../types/inventoryItem';
import type { CustomerOrderView, PlaceOrderBody } from '../types/customerOrder';
import { orderFulfillmentStatusSchema } from '../types/customerAppOrder';
import type { OrderFulfillmentStatus } from '../types/customerAppOrder';
import { computeFees, paiseToRupees, rupeesToPaise } from './money';
import { assertTransition, buildOrderEvent, canTransition } from './orderState';

type Doc = Record<string, unknown>;

const INVENTORY = 'duo_face_inventory';

function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
}

/** Same order for the same customer + client request id, whatever the retry count. */
export function buildOrderId(uid: string, clientRequestId: string): string {
  return `ord_${uid}_${clientRequestId}`;
}

/**
 * Customer checkout, history and cancel. Every price comes from Firestore
 * (never the client); stock is checked and decremented in the SAME Firestore
 * transaction that creates the order, so two buyers can never both get the
 * last unit; and every status write goes through orderState + order_events.
 */
export class CustomerOrderService {
  constructor(
    private readonly store: CustomerStore = new FirestoreCustomerStore(),
    private readonly now: () => Date = () => new Date()
  ) {}

  async placeOrder(uid: string, body: PlaceOrderBody): Promise<{ order: CustomerOrderView; created: boolean }> {
    const address = await this.store.getAddress(uid, body.addressId);
    if (!address) throw new AppError(404, 'Delivery address not found');

    // Merge duplicate lines for the same product.
    const wanted = new Map<string, number>();
    for (const i of body.items) wanted.set(i.productId, (wanted.get(i.productId) ?? 0) + i.quantity);
    for (const q of wanted.values()) {
      if (q > 50) throw new AppError(400, 'Quantity per product is limited to 50');
    }

    const orderId = buildOrderId(uid, body.clientRequestId);

    return this.store.runTransaction(async (tx) => {
      // ---- all reads first ----
      const existing = await tx.get('orders', orderId);
      if (existing) {
        return { order: this.toView({ ...existing, orderId }), created: false }; // idempotent retry: no second decrement
      }

      const shop = await tx.get('shops', body.shopId);
      if (!shop || shop.isActive === false) throw new AppError(404, 'Shop not found');
      if (shop.isOpen === false) throw new AppError(409, 'This shop is closed right now');

      const lines: { productId: string; name: string; qty: number; pricePaise: number; inventory: Doc }[] = [];
      for (const [productId, qty] of wanted) {
        const product = await tx.get('products', productId);
        if (!product || product.shopId !== body.shopId || product.isActive === false) {
          throw new AppError(404, 'A product in your cart is no longer available');
        }
        if (product.inStock === false) throw new AppError(409, `${String(product.name)} is out of stock`);

        const inventory = await tx.get(INVENTORY, buildInventoryId(body.shopId, productId));
        const parsed = inventory ? inventoryItemSchema.safeParse(inventory) : null;
        if (!parsed || !parsed.success || parsed.data.status !== 'active') {
          throw new AppError(409, `${String(product.name)} is out of stock`);
        }
        const available = parsed.data.quantity - parsed.data.reservedQuantity;
        if (available < qty) {
          throw new AppError(409, `Only ${Math.max(available, 0)} of ${String(product.name)} left`);
        }
        lines.push({
          productId,
          name: String(product.name),
          qty,
          pricePaise: rupeesToPaise(product.price),
          inventory: inventory as Doc,
        });
      }

      // ---- pricing, integer paise only ----
      const subtotalPaise = lines.reduce((sum, l) => sum + l.pricePaise * l.qty, 0);
      const fees = computeFees(subtotalPaise);
      const totalPaise = subtotalPaise + fees.deliveryFeePaise + fees.platformFeePaise;
      const now = this.now();

      // ---- writes (buffered, applied after reads) ----
      for (const l of lines) {
        tx.set(INVENTORY, buildInventoryId(body.shopId, l.productId), {
          ...l.inventory,
          quantity: Number(l.inventory.quantity) - l.qty,
          updatedAt: now,
        });
      }

      const order: Doc = {
        customerId: uid,
        shopId: body.shopId,
        shopName: String(shop.name ?? ''),
        // Existing fields stay rupees (the merchant side reads them as such); *Paise fields are the exact values.
        items: lines.map((l) => ({
          productId: l.productId,
          name: l.name,
          price: paiseToRupees(l.pricePaise),
          quantity: l.qty,
          subtotal: paiseToRupees(l.pricePaise * l.qty),
          pricePaise: l.pricePaise,
          subtotalPaise: l.pricePaise * l.qty,
        })),
        delivery: {
          addressId: body.addressId,
          label: String(address.label ?? ''),
          fullAddress: String(address.fullAddress ?? ''),
          phoneNumber: String(address.phoneNumber ?? ''),
          ...(typeof address.latitude === 'number' && typeof address.longitude === 'number'
            ? { latitude: address.latitude, longitude: address.longitude }
            : {}),
        },
        pricing: {
          subtotal: paiseToRupees(subtotalPaise),
          deliveryFee: paiseToRupees(fees.deliveryFeePaise),
          platformFee: paiseToRupees(fees.platformFeePaise),
          total: paiseToRupees(totalPaise),
        },
        pricingPaise: {
          subtotal: subtotalPaise,
          deliveryFee: fees.deliveryFeePaise,
          platformFee: fees.platformFeePaise,
          total: totalPaise,
        },
        status: 'pending',
        paymentMethod: body.paymentMethod,
        paymentStatus: 'pending', // cash on delivery: collected by the driver, not tracked online
        createdAt: now,
        updatedAt: now,
      };
      tx.set('orders', orderId, order);
      tx.set(
        'order_events',
        `${orderId}__created`,
        { ...buildOrderEvent(orderId, body.shopId, null, 'pending', { type: 'customer', id: uid }, now) }
      );

      return { order: this.toView({ ...order, orderId }), created: true };
    });
  }

  async listOrders(uid: string): Promise<CustomerOrderView[]> {
    const rows = await this.store.listOrdersByCustomer(uid);
    return rows
      .filter((r) => r.customerId === uid)
      .map((r) => ({ view: this.toView(r), at: toIso(r.createdAt) ?? '' }))
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((x) => x.view);
  }

  async getOrder(uid: string, orderId: string): Promise<CustomerOrderView> {
    const raw = await this.store.getOrder(orderId);
    // Missing and someone else's look identical (no order-id probing).
    if (!raw || raw.customerId !== uid) throw new AppError(404, 'Order not found');
    return this.toView(raw);
  }

  /** Customer cancel: only while `pending`; stock goes back in the same transaction. */
  async cancelOrder(uid: string, orderId: string): Promise<CustomerOrderView> {
    return this.store.runTransaction(async (tx: CheckoutTx) => {
      const raw = await tx.get('orders', orderId);
      if (!raw || raw.customerId !== uid) throw new AppError(404, 'Order not found');

      const status = orderFulfillmentStatusSchema.safeParse(raw.status);
      if (!status.success) throw new AppError(409, 'Order is in an unknown state');
      if (status.data === 'cancelled') return this.toView({ ...raw, orderId }); // idempotent
      if (!canTransition(status.data, 'cancelled') || status.data !== 'pending') {
        throw new AppError(409, 'This order can no longer be cancelled');
      }
      assertTransition(status.data, 'cancelled');

      const shopId = String(raw.shopId);
      const items = Array.isArray(raw.items) ? (raw.items as Doc[]) : [];
      const inventories: { productId: string; qty: number; doc: Doc | null }[] = [];
      for (const item of items) {
        const productId = String(item.productId);
        inventories.push({
          productId,
          qty: Number(item.quantity),
          doc: await tx.get(INVENTORY, buildInventoryId(shopId, productId)),
        });
      }

      const now = this.now();
      for (const inv of inventories) {
        if (!inv.doc) continue; // inventory record was removed meanwhile: nothing to restore into
        tx.set(INVENTORY, buildInventoryId(shopId, inv.productId), {
          ...inv.doc,
          quantity: Number(inv.doc.quantity) + inv.qty,
          updatedAt: now,
        });
      }
      const updated: Doc = {
        ...raw,
        status: 'cancelled' satisfies OrderFulfillmentStatus,
        cancelledAt: now,
        cancellationReason: 'customer_cancelled',
        updatedAt: now,
      };
      tx.set('orders', orderId, updated);
      tx.set(
        'order_events',
        `${orderId}__pending_cancelled`,
        { ...buildOrderEvent(orderId, shopId, 'pending', 'cancelled', { type: 'customer', id: uid }, now) }
      );
      return this.toView({ ...updated, orderId });
    });
  }

  private toView(raw: Doc): CustomerOrderView {
    const items = (Array.isArray(raw.items) ? (raw.items as Doc[]) : []).map((i) => {
      const pricePaise = typeof i.pricePaise === 'number' ? i.pricePaise : rupeesToPaise(i.price);
      const quantity = Number(i.quantity);
      return {
        productId: String(i.productId),
        name: String(i.name),
        quantity,
        pricePaise,
        subtotalPaise: typeof i.subtotalPaise === 'number' ? i.subtotalPaise : pricePaise * quantity,
      };
    });
    const p = (raw.pricingPaise ?? {}) as Doc;
    const subtotalPaise = typeof p.subtotal === 'number' ? p.subtotal : items.reduce((s, i) => s + i.subtotalPaise, 0);
    const deliveryFeePaise = typeof p.deliveryFee === 'number' ? p.deliveryFee : 0;
    const platformFeePaise = typeof p.platformFee === 'number' ? p.platformFee : 0;
    const d = (raw.delivery ?? {}) as Doc;
    return {
      orderId: String(raw.orderId),
      shopId: String(raw.shopId),
      shopName: String(raw.shopName ?? ''),
      status: String(raw.status),
      paymentMethod: String(raw.paymentMethod ?? ''),
      paymentStatus: String(raw.paymentStatus ?? ''),
      items,
      delivery: {
        label: String(d.label ?? ''),
        fullAddress: String(d.fullAddress ?? ''),
        phoneNumber: String(d.phoneNumber ?? ''),
      },
      pricing: {
        subtotalPaise,
        deliveryFeePaise,
        platformFeePaise,
        totalPaise: typeof p.total === 'number' ? p.total : subtotalPaise + deliveryFeePaise + platformFeePaise,
      },
      createdAt: toIso(raw.createdAt),
    };
  }
}
