import { FirestoreCustomerStore } from '../integrations/firebase/FirestoreCustomerStore';
import type { CustomerStore } from '../integrations/firebase/FirestoreCustomerStore';
import { gatewayOrderIdFor, PaymentGatewayError, toTenDigitPhone } from '../integrations/payments/CashfreeGateway';
import type { GatewayOrder, PaymentGateway } from '../integrations/payments/CashfreeGateway';
import { AppError } from '../middleware/errorHandler';
import type { CustomerOrderView } from '../types/customerOrder';
import type { CustomerOrderService } from './customerOrderService';
import { appEvents } from './appEvents';
import type { AppEvents } from './appEvents';
import { buildOrderEvent } from './orderState';
import { restoreStock } from './orderStatusService';

type Doc = Record<string, unknown>;

export const PAYMENTS_COLLECTION = 'duo_face_payments';

/** After the hold ends we wait a little before cancelling, so a payment finishing right then is not lost. */
const EXPIRY_GRACE_MS = 60_000;

/** Date or Firestore Timestamp. Duck-typed so a Date from another JS realm (e.g. a structured clone) still counts. */
function toDate(value: unknown): Date | null {
  if (Object.prototype.toString.call(value) === '[object Date]') return new Date((value as Date).getTime());
  if (value && typeof (value as { toDate?: unknown }).toDate === 'function') return (value as { toDate: () => Date }).toDate();
  return null;
}

export type ApplyResult = 'paid' | 'already_paid' | 'amount_mismatch' | 'needs_refund' | 'unknown_payment';

/**
 * Online payment through Cashfree. Core rule: an order becomes `paid` only
 * after THIS server has asked Cashfree and been told `PAID` for the exact
 * amount: never because the app, a redirect or a webhook body said so.
 * Paths that lead here: the webhook, the customer's "verify" call, and the
 * expiry sweep. All of them are idempotent.
 */
export class PaymentService {
  constructor(
    private readonly orders: CustomerOrderService,
    private readonly gateway: PaymentGateway | null,
    private readonly publicBaseUrl: string | null,
    private readonly store: CustomerStore = new FirestoreCustomerStore(),
    private readonly now: () => Date = () => new Date(),
    private readonly events: AppEvents = appEvents
  ) {}

  get enabled(): boolean {
    return this.gateway !== null && this.publicBaseUrl !== null;
  }

  private requireGateway(): { gateway: PaymentGateway; baseUrl: string } {
    if (!this.gateway || !this.publicBaseUrl) throw new AppError(503, 'Online payment is not available right now.');
    return { gateway: this.gateway, baseUrl: this.publicBaseUrl };
  }

  private async loadOwnedOnlineOrder(uid: string, orderId: string): Promise<Doc> {
    const raw = await this.store.getOrder(orderId);
    if (!raw || raw.customerId !== uid) throw new AppError(404, 'Order not found');
    if (raw.paymentMethod !== 'online') throw new AppError(409, 'This is not an online-payment order.');
    return raw;
  }

  /** Returns the page where the customer pays. Safe to call again for the same order (returns the same session). */
  async startPayment(uid: string, orderId: string): Promise<{ checkoutUrl: string }> {
    const { gateway, baseUrl } = this.requireGateway();
    const order = await this.loadOwnedOnlineOrder(uid, orderId);
    if (order.paymentStatus === 'paid') throw new AppError(409, 'This order is already paid.');
    if (order.paymentStatus !== 'awaiting_payment') throw new AppError(409, 'This order is no longer waiting for payment.');

    const expiresAt = toDate(order.paymentExpiresAt);
    if (!expiresAt || expiresAt.getTime() <= this.now().getTime()) throw new AppError(409, 'The time to pay for this order has ended.');

    const gatewayOrderId = gatewayOrderIdFor(orderId);
    const totalPaise = Number((order.pricingPaise as Doc | undefined)?.total);
    if (!Number.isInteger(totalPaise) || totalPaise < 100) throw new AppError(409, 'This order cannot be paid online.');

    try {
      let g = await gateway.getOrder(gatewayOrderId);
      if (!g) {
        const phone = toTenDigitPhone(String((order.delivery as Doc | undefined)?.phoneNumber ?? ''));
        if (!phone) throw new AppError(409, 'The phone number on this order is not a valid Indian mobile number.');
        try {
          g = await gateway.createOrder({
            gatewayOrderId,
            amountPaise: totalPaise,
            customerId: uid,
            customerPhone: phone,
            returnUrl: `${baseUrl}/pay/return`,
            notifyUrl: `${baseUrl}/webhooks/cashfree`,
            expiresAt,
          });
        } catch (err) {
          // A concurrent start created it first: use that one.
          if (err instanceof PaymentGatewayError && err.category === 'rejected') g = await gateway.getOrder(gatewayOrderId);
          else throw err;
          if (!g) throw err;
        }
        await this.recordPayment(gatewayOrderId, orderId, uid, String(order.shopId), totalPaise);
      }
      if (g.status === 'PAID') {
        await this.applyGatewayResult(gatewayOrderId, g.amountPaise);
        throw new AppError(409, 'This order is already paid.');
      }
      if (g.status !== 'ACTIVE' || !g.paymentSessionId) throw new AppError(409, 'The time to pay for this order has ended.');
      return { checkoutUrl: `${baseUrl}/pay/checkout?session=${encodeURIComponent(g.paymentSessionId)}` };
    } catch (err) {
      throw this.mapGatewayError(err);
    }
  }

  /** The customer says they paid (or came back from the payment page): ask Cashfree, never take their word. */
  async verify(uid: string, orderId: string): Promise<CustomerOrderView> {
    const order = await this.loadOwnedOnlineOrder(uid, orderId);
    if (order.paymentStatus === 'awaiting_payment') await this.reconcile(orderId, order);
    return this.orders.getOrder(uid, orderId);
  }

  /** Cashfree webhook. Signature is checked by the caller's raw-body route; this still re-confirms with the API. */
  async handleWebhook(rawBody: string, timestamp: string, signature: string): Promise<'applied' | 'ignored'> {
    const { gateway } = this.requireGateway();
    if (!gateway.verifyWebhookSignature(rawBody, timestamp, signature)) throw new AppError(401, 'Invalid webhook signature.');

    let payload: { type?: unknown; data?: { order?: { order_id?: unknown } } };
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new AppError(400, 'Invalid webhook body.');
    }
    // Only a success event can change anything; failures/drops simply let the customer retry or the hold expire.
    if (payload.type !== 'PAYMENT_SUCCESS_WEBHOOK') return 'ignored';
    const gatewayOrderId = payload.data?.order?.order_id;
    if (typeof gatewayOrderId !== 'string' || !/^cf_[a-f0-9]{32}$/.test(gatewayOrderId)) return 'ignored';

    try {
      const g = await gateway.getOrder(gatewayOrderId);
      if (g?.status !== 'PAID') return 'ignored';
      const result = await this.applyGatewayResult(gatewayOrderId, g.amountPaise);
      return result === 'unknown_payment' ? 'ignored' : 'applied';
    } catch (err) {
      throw this.mapGatewayError(err); // 5xx lets Cashfree retry the webhook
    }
  }

  /** Settles every unpaid online order whose hold has ended. Run on a timer. */
  async sweep(): Promise<{ paid: number; expired: number }> {
    if (!this.enabled) return { paid: 0, expired: 0 };
    const result = { paid: 0, expired: 0 };
    const waiting = await this.store.listAwaitingPaymentOrders();
    for (const order of waiting) {
      const expiresAt = toDate(order.paymentExpiresAt);
      if (!expiresAt || this.now().getTime() < expiresAt.getTime() + EXPIRY_GRACE_MS) continue;
      try {
        const outcome = await this.reconcile(String(order.orderId), order);
        if (outcome === 'paid') result.paid += 1;
        if (outcome === 'expired') result.expired += 1;
      } catch {
        console.warn(`PaymentService: could not settle order ${String(order.orderId)}; will retry`);
      }
    }
    return result;
  }

  /** Ask Cashfree what happened and bring the order in line. */
  private async reconcile(orderId: string, order: Doc): Promise<'paid' | 'expired' | 'waiting'> {
    const { gateway } = this.requireGateway();
    const gatewayOrderId = gatewayOrderIdFor(orderId);
    let g: GatewayOrder | null;
    try {
      g = await gateway.getOrder(gatewayOrderId);
    } catch (err) {
      throw this.mapGatewayError(err);
    }
    if (g?.status === 'PAID') {
      const result = await this.applyGatewayResult(gatewayOrderId, g.amountPaise);
      return result === 'paid' || result === 'already_paid' ? 'paid' : 'waiting';
    }
    const expiresAt = toDate(order.paymentExpiresAt);
    const holdOver = !!expiresAt && this.now().getTime() >= expiresAt.getTime() + EXPIRY_GRACE_MS;
    const gatewayDone = g !== null && (g.status === 'EXPIRED' || g.status === 'TERMINATED');
    if (holdOver || gatewayDone) {
      if (await this.cancelUnpaid(orderId)) void this.events.paymentExpired(orderId);
      void gateway.terminateOrder(gatewayOrderId);
      return 'expired';
    }
    return 'waiting';
  }

  private async recordPayment(gatewayOrderId: string, orderId: string, uid: string, shopId: string, amountPaise: number): Promise<void> {
    await this.store.runTransaction(async (tx) => {
      if (await tx.get(PAYMENTS_COLLECTION, gatewayOrderId)) return;
      const at = this.now();
      tx.set(PAYMENTS_COLLECTION, gatewayOrderId, {
        gatewayOrderId,
        provider: 'cashfree',
        orderId,
        customerId: uid,
        shopId,
        amountPaise,
        status: 'created',
        createdAt: at,
        updatedAt: at,
      });
    });
  }

  /**
   * Mark an order paid, atomically with its payment record. Amount must match
   * exactly. A payment that lands on an order we already cancelled/expired is
   * recorded for refund instead of reviving the order.
   */
  async applyGatewayResult(gatewayOrderId: string, paidAmountPaise: number): Promise<ApplyResult> {
    let settledOrderId: string | null = null;
    const result = await this.store.runTransaction(async (tx) => {
      settledOrderId = null;
      const payment = await tx.get(PAYMENTS_COLLECTION, gatewayOrderId);
      if (!payment) return 'unknown_payment' as ApplyResult;
      if (payment.status === 'paid') return 'already_paid' as ApplyResult;

      const orderId = String(payment.orderId);
      settledOrderId = orderId;
      const order = await tx.get('orders', orderId);
      if (!order) return 'unknown_payment' as ApplyResult;

      const at = this.now();
      const expected = Number((order.pricingPaise as Doc | undefined)?.total);
      if (paidAmountPaise !== expected) {
        tx.set(PAYMENTS_COLLECTION, gatewayOrderId, { ...payment, status: 'amount_mismatch', paidAmountPaise, updatedAt: at });
        console.warn(`PaymentService: amount mismatch on order ${orderId}; not marked paid`);
        return 'amount_mismatch' as ApplyResult;
      }

      if (order.paymentStatus === 'awaiting_payment') {
        tx.set(PAYMENTS_COLLECTION, gatewayOrderId, { ...payment, status: 'paid', paidAmountPaise, paidAt: at, updatedAt: at });
        tx.set('orders', orderId, { ...order, paymentStatus: 'paid', paidAt: at, updatedAt: at });
        tx.set('order_events', `${orderId}__payment_paid`, {
          ...buildOrderEvent(orderId, String(order.shopId), 'pending', 'pending', { type: 'system', id: 'cashfree' }, at),
          note: 'payment_paid',
        });
        return 'paid' as ApplyResult;
      }

      // Paid, but we had already cancelled/expired the order: keep the money visible for a manual refund.
      tx.set(PAYMENTS_COLLECTION, gatewayOrderId, { ...payment, status: 'paid_needs_refund', paidAmountPaise, paidAt: at, updatedAt: at });
      tx.set('orders', orderId, { ...order, refundRequired: true, updatedAt: at });
      console.warn(`PaymentService: order ${orderId} was paid after it was ${String(order.status)}; refund required`);
      return 'needs_refund' as ApplyResult;
    });
    // Tell people only after the money change is saved (each notification is sent at most once per order).
    if (settledOrderId) {
      if (result === 'paid') void this.events.paymentConfirmed(settledOrderId);
      if (result === 'needs_refund') void this.events.refundDue(settledOrderId);
    }
    return result;
  }

  /** Cancel an unpaid online order (hold ran out / gateway order expired) and release its stock. */
  private async cancelUnpaid(orderId: string): Promise<boolean> {
    return this.store.runTransaction(async (tx) => {
      const order = await tx.get('orders', orderId);
      if (!order || order.paymentStatus !== 'awaiting_payment' || order.status !== 'pending') return false;
      const payment = await tx.get(PAYMENTS_COLLECTION, gatewayOrderIdFor(orderId));
      const at = this.now();
      await restoreStock(tx, String(order.shopId), Array.isArray(order.items) ? (order.items as Doc[]) : [], at);
      tx.set('orders', orderId, {
        ...order,
        status: 'cancelled',
        paymentStatus: 'expired',
        cancelledAt: at,
        cancellationReason: 'payment_expired',
        updatedAt: at,
      });
      if (payment && payment.status === 'created') {
        tx.set(PAYMENTS_COLLECTION, gatewayOrderIdFor(orderId), { ...payment, status: 'expired', updatedAt: at });
      }
      tx.set(
        'order_events',
        `${orderId}__pending_cancelled`,
        { ...buildOrderEvent(orderId, String(order.shopId), 'pending', 'cancelled', { type: 'system', id: 'payment_expiry' }, at) }
      );
      return true;
    });
  }

  private mapGatewayError(err: unknown): unknown {
    if (err instanceof PaymentGatewayError) {
      return new AppError(502, err.category === 'rejected' ? 'The payment provider rejected the request.' : 'The payment provider is not reachable right now. Please try again.');
    }
    return err;
  }
}
