import { FirestoreCustomerStore } from '../integrations/firebase/FirestoreCustomerStore';
import type { CustomerStore } from '../integrations/firebase/FirestoreCustomerStore';
import { gatewayOrderIdFor, idempotencyKeyFor, PaymentGatewayError, refundIdFor } from '../integrations/payments/CashfreeGateway';
import type { GatewayRefund, PaymentGateway } from '../integrations/payments/CashfreeGateway';
import { AppError } from '../middleware/errorHandler';
import { appEvents } from './appEvents';
import type { AppEvents } from './appEvents';
import { buildOrderEvent } from './orderState';
import { PAYMENTS_COLLECTION } from './paymentService';

type Doc = Record<string, unknown>;

export type RefundState = 'due' | 'processing' | 'failed' | 'refunded';

/** Where a refund stands after asking Cashfree. */
type Settled = 'completed' | 'processing' | 'failed';

export interface RefundView {
  orderId: string;
  shopName: string;
  orderStatus: string;
  /** Why money is owed: the shop rejected it, or it was cancelled/expired after the customer paid. */
  reason: 'rejected_by_shop' | 'cancelled_after_payment' | 'other';
  deliveryPhone: string;
  totalPaise: number;
  /** What was actually paid, and what a refund returns. */
  paidAmountPaise: number;
  createdAt: string | null;
  refund: {
    state: RefundState;
    attempt: number;
    requestedAt: string | null;
    requestedBy: string | null;
    processedAt: string | null;
  };
}

const MAX_REFUNDED_SHOWN = 50;

function toIso(value: unknown): string | null {
  if (Object.prototype.toString.call(value) === '[object Date]') return (value as Date).toISOString();
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') return (value as { toDate: () => Date }).toDate().toISOString();
  return null;
}

/**
 * Full refunds for online orders flagged `refundRequired` (shop rejected a
 * paid order, or a payment landed on a cancelled/expired one). Admin-only.
 *
 * Safety: the refund is written to the order as `processing` BEFORE Cashfree
 * is called, under a refund id derived from (order, attempt). So a double
 * click, a retry, or a crash halfway can never refund twice: every path
 * first asks Cashfree whether that exact refund id exists. Only `failed`
 * (Cashfree cancelled/rejected it) allows a new attempt, with a new id.
 */
export class RefundService {
  constructor(
    private readonly gateway: PaymentGateway | null,
    private readonly store: CustomerStore = new FirestoreCustomerStore(),
    private readonly now: () => Date = () => new Date(),
    private readonly events: AppEvents = appEvents
  ) {}

  private requireGateway(): PaymentGateway {
    if (!this.gateway) throw new AppError(503, 'Online payment is not configured, so refunds are unavailable.');
    return this.gateway;
  }

  async list(): Promise<{ open: RefundView[]; refunded: RefundView[] }> {
    const [open, refunded] = await Promise.all([this.store.listRefundOrders(), this.store.listRefundedOrders(MAX_REFUNDED_SHOWN)]);
    const toViews = async (orders: Doc[]) => {
      const views: RefundView[] = [];
      for (const order of orders) {
        const payment = await this.loadPayment(String(order.orderId));
        views.push(this.toView(order, payment));
      }
      return views;
    };
    const byNewest = (a: RefundView, b: RefundView) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
    return { open: (await toViews(open)).sort(byNewest), refunded: (await toViews(refunded)).sort(byNewest) };
  }

  async get(orderId: string): Promise<RefundView> {
    const order = await this.store.getOrder(orderId);
    if (!order || !this.isRefundOrder(order)) throw new AppError(404, 'No refund found for this order.');
    return this.toView(order, await this.loadPayment(orderId));
  }

  /** Refund the full amount paid. Safe to click twice. */
  async startRefund(adminUid: string, orderId: string): Promise<RefundView> {
    this.requireGateway();
    const plan = await this.store.runTransaction(async (tx) => {
      const order = await tx.get('orders', orderId);
      if (!order || order.paymentMethod !== 'online' || order.refundRequired !== true) throw new AppError(409, 'No refund is due for this order.');
      // First, where does this refund already stand? A repeat click must resume it, never start another.
      const current = order.refund as Doc | undefined;
      if (current?.status === 'refunded') throw new AppError(409, 'This order has already been refunded.');
      if (current?.status === 'processing') {
        return { refundId: String(current.refundId), amountPaise: Number(current.amountPaise), fresh: false };
      }

      const gatewayOrderId = gatewayOrderIdFor(orderId);
      const payment = await tx.get(PAYMENTS_COLLECTION, gatewayOrderId);
      const amountPaise = Number(payment?.paidAmountPaise);
      if (!payment || !['paid', 'paid_needs_refund', 'refund_failed'].includes(String(payment.status)) || !Number.isInteger(amountPaise) || amountPaise < 100) {
        throw new AppError(409, 'There is no confirmed payment to refund for this order.');
      }

      const attempt = Number(current?.attempt ?? 0) + 1;
      const refundId = refundIdFor(orderId, attempt);
      const at = this.now();
      tx.set('orders', orderId, {
        ...order,
        refund: { status: 'processing', refundId, attempt, amountPaise, requestedAt: at, requestedBy: adminUid },
        updatedAt: at,
      });
      tx.set(PAYMENTS_COLLECTION, gatewayOrderId, { ...payment, status: 'refund_processing', updatedAt: at });
      tx.set(`order_events`, `${orderId}__refund_requested_${attempt}`, {
        ...buildOrderEvent(orderId, String(order.shopId), null, 'cancelled', { type: 'admin', id: adminUid }, at),
        note: 'refund_requested',
        refundId,
        amountPaise,
      });
      return { refundId, amountPaise, fresh: true };
    });

    const outcome = await this.settle(orderId, plan.refundId, plan.amountPaise, adminUid);
    // Told once each, after the change is saved: "started" once Cashfree has accepted it (not if it was refused),
    // "completed" when Cashfree confirms.
    if (plan.fresh && outcome !== 'failed') void this.events.refundStarted(orderId);
    if (outcome === 'completed') void this.events.refundCompleted(orderId);
    return this.get(orderId);
  }

  /** Ask Cashfree where a processing refund stands. */
  async refresh(adminUid: string, orderId: string): Promise<RefundView> {
    this.requireGateway();
    const order = await this.store.getOrder(orderId);
    if (!order || !this.isRefundOrder(order)) throw new AppError(404, 'No refund found for this order.');
    const refund = order.refund as Doc | undefined;
    if (refund?.status === 'processing') {
      if ((await this.settle(orderId, String(refund.refundId), Number(refund.amountPaise), adminUid)) === 'completed') void this.events.refundCompleted(orderId);
    }
    return this.get(orderId);
  }

  /** Timer: settle every refund still in progress. Returns how many reached a final state. */
  async sweep(): Promise<number> {
    if (!this.gateway) return 0;
    let finished = 0;
    for (const order of await this.store.listRefundOrders()) {
      const refund = order.refund as Doc | undefined;
      if (refund?.status !== 'processing') continue;
      try {
        if ((await this.settle(String(order.orderId), String(refund.refundId), Number(refund.amountPaise), 'system')) === 'completed') {
          void this.events.refundCompleted(String(order.orderId));
        }
        const after = await this.store.getOrder(String(order.orderId));
        if ((after?.refund as Doc | undefined)?.status !== 'processing') finished += 1;
      } catch {
        console.warn(`RefundService: could not settle refund for order ${String(order.orderId)}; will retry`);
      }
    }
    return finished;
  }

  /** Look the refund up at Cashfree (creating it only if it truly does not exist yet), then record the result. */
  private async settle(orderId: string, refundId: string, amountPaise: number, actorId: string): Promise<Settled> {
    const gateway = this.requireGateway();
    const gatewayOrderId = gatewayOrderIdFor(orderId);
    let result: GatewayRefund;
    try {
      let existing = await gateway.getRefund(gatewayOrderId, refundId);
      if (!existing) {
        existing = await gateway.createRefund({
          gatewayOrderId,
          refundId,
          amountPaise,
          note: 'Order refund',
          idempotencyKey: idempotencyKeyFor(refundId),
        });
      }
      result = existing;
    } catch (err) {
      if (err instanceof PaymentGatewayError && err.category === 'rejected') {
        await this.record(orderId, refundId, 'REJECTED', actorId);
        throw new AppError(409, 'The payment provider refused this refund. Check the order in the Cashfree dashboard.');
      }
      // Transient: the refund stays "processing" and is re-checked by Refresh / the timer.
      throw new AppError(502, 'The payment provider is not reachable right now. The refund is recorded as processing; try Refresh in a minute.');
    }
    if (result.amountPaise !== amountPaise && result.status === 'SUCCESS') {
      console.warn(`RefundService: refund amount mismatch on order ${orderId}`);
    }
    return this.record(orderId, refundId, result.status, actorId);
  }

  /** Write the outcome onto the order and payment record. Ignores a result for an outdated attempt. */
  /** What this call did to the refund (`processing` also covers "nothing to change"). */
  private async record(orderId: string, refundId: string, status: GatewayRefund['status'], actorId: string): Promise<Settled> {
    return this.store.runTransaction(async (tx) => {
      const order = await tx.get('orders', orderId);
      const refund = order?.refund as Doc | undefined;
      if (!order || !refund || refund.refundId !== refundId || refund.status !== 'processing') return 'processing' as Settled;
      const gatewayOrderId = gatewayOrderIdFor(orderId);
      const payment = await tx.get(PAYMENTS_COLLECTION, gatewayOrderId);
      const at = this.now();
      const attempt = Number(refund.attempt);
      const actor = actorId === 'system' ? ({ type: 'system', id: 'refund_sweep' } as const) : ({ type: 'admin', id: actorId } as const);

      if (status === 'SUCCESS') {
        tx.set('orders', orderId, { ...order, refundRequired: false, refund: { ...refund, status: 'refunded', processedAt: at }, updatedAt: at });
        if (payment) tx.set(PAYMENTS_COLLECTION, gatewayOrderId, { ...payment, status: 'refunded', refundedAt: at, updatedAt: at });
        tx.set('order_events', `${orderId}__refund_completed`, {
          ...buildOrderEvent(orderId, String(order.shopId), null, 'cancelled', actor, at),
          note: 'refund_completed',
          refundId,
        });
        return 'completed' as Settled;
      } else if (status === 'CANCELLED' || status === 'REJECTED') {
        tx.set('orders', orderId, { ...order, refund: { ...refund, status: 'failed', processedAt: at }, updatedAt: at });
        if (payment) tx.set(PAYMENTS_COLLECTION, gatewayOrderId, { ...payment, status: 'refund_failed', updatedAt: at });
        tx.set('order_events', `${orderId}__refund_failed_${attempt}`, {
          ...buildOrderEvent(orderId, String(order.shopId), null, 'cancelled', actor, at),
          note: 'refund_failed',
          refundId,
        });
        return 'failed' as Settled;
      }
      // PENDING / PENDING_APPROVAL / ONHOLD / UNKNOWN: still in progress, nothing to write.
      return 'processing' as Settled;
    });
  }

  private isRefundOrder(order: Doc): boolean {
    const refund = order.refund as Doc | undefined;
    return order.refundRequired === true || refund?.status === 'refunded';
  }

  private async loadPayment(orderId: string): Promise<Doc | null> {
    return this.store.runTransaction((tx) => tx.get(PAYMENTS_COLLECTION, gatewayOrderIdFor(orderId)));
  }

  private toView(order: Doc, payment: Doc | null): RefundView {
    const refund = order.refund as Doc | undefined;
    const state: RefundState = refund?.status === 'refunded' ? 'refunded' : refund?.status === 'processing' ? 'processing' : refund?.status === 'failed' ? 'failed' : 'due';
    const delivery = (order.delivery as Doc | undefined) ?? {};
    const pricing = (order.pricingPaise as Doc | undefined) ?? {};
    return {
      orderId: String(order.orderId),
      shopName: String(order.shopName ?? ''),
      orderStatus: String(order.status),
      reason: order.status === 'rejected' ? 'rejected_by_shop' : order.status === 'cancelled' ? 'cancelled_after_payment' : 'other',
      deliveryPhone: String(delivery.phoneNumber ?? ''),
      totalPaise: Number(pricing.total ?? 0),
      paidAmountPaise: Number(payment?.paidAmountPaise ?? pricing.total ?? 0),
      createdAt: toIso(order.createdAt),
      refund: {
        state,
        attempt: Number(refund?.attempt ?? 0),
        requestedAt: toIso(refund?.requestedAt),
        requestedBy: typeof refund?.requestedBy === 'string' ? refund.requestedBy : null,
        processedAt: toIso(refund?.processedAt),
      },
    };
  }
}
