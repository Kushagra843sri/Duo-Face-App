import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { CashfreeConfig } from '../../config/cashfree';

/** Cashfree API version these calls were written against (docs: create/get order). */
export const CASHFREE_API_VERSION = '2026-01-01';

export type GatewayOrderStatus = 'ACTIVE' | 'PAID' | 'EXPIRED' | 'TERMINATED' | 'TERMINATION_REQUESTED' | 'UNKNOWN';

export interface GatewayOrder {
  status: GatewayOrderStatus;
  /** Exact amount in integer paise (converted once from Cashfree's decimal rupees). */
  amountPaise: number;
  paymentSessionId: string | null;
}

export interface CreateGatewayOrderInput {
  /** Our payment reference (3-45 chars: letters, digits, _ and -). */
  gatewayOrderId: string;
  amountPaise: number;
  customerId: string;
  /** 10-digit Indian mobile number. */
  customerPhone: string;
  returnUrl: string;
  notifyUrl: string;
  expiresAt: Date;
}

/** Safe, categorized failure: never carries Cashfree's response body, keys or customer data. */
export class PaymentGatewayError extends Error {
  constructor(
    readonly category: 'transient' | 'rejected' | 'not_found',
    readonly httpStatus?: number
  ) {
    super(`payment gateway ${category}${httpStatus ? ` (${httpStatus})` : ''}`);
    this.name = 'PaymentGatewayError';
  }
}

export interface PaymentGateway {
  readonly mode: 'sandbox' | 'production';
  createOrder(input: CreateGatewayOrderInput): Promise<GatewayOrder>;
  getOrder(gatewayOrderId: string): Promise<GatewayOrder | null>;
  /** Best effort: stop a still-unpaid gateway order from being paid after we cancelled it. */
  terminateOrder(gatewayOrderId: string): Promise<void>;
  verifyWebhookSignature(rawBody: string, timestamp: string, signature: string): boolean;
}

/** Deterministic and within Cashfree's 45-character limit, whatever our order id looks like. */
export function gatewayOrderIdFor(orderId: string): string {
  return `cf_${createHash('sha256').update(orderId).digest('hex').slice(0, 32)}`;
}

/** Cashfree wants the 10-digit national number. Returns null for anything else. */
export function toTenDigitPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  const national = digits.length > 10 ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(national) ? national : null;
}

const TIMEOUT_MS = 10_000;

type FetchLike = typeof fetch;

export class CashfreeGateway implements PaymentGateway {
  constructor(
    private readonly config: CashfreeConfig,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  get mode() {
    return this.config.env;
  }

  private get baseUrl() {
    return this.config.env === 'production' ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
  }

  private async call(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'x-api-version': CASHFREE_API_VERSION,
          'x-client-id': this.config.appId,
          'x-client-secret': this.config.secretKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new PaymentGatewayError('transient');
    }
    if (response.status === 404) throw new PaymentGatewayError('not_found', 404);
    if (!response.ok) {
      throw new PaymentGatewayError(response.status >= 500 || response.status === 429 ? 'transient' : 'rejected', response.status);
    }
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      throw new PaymentGatewayError('transient');
    }
  }

  private toOrder(raw: Record<string, unknown>): GatewayOrder {
    const known = ['ACTIVE', 'PAID', 'EXPIRED', 'TERMINATED', 'TERMINATION_REQUESTED'];
    const amount = Number(raw.order_amount);
    return {
      status: known.includes(String(raw.order_status)) ? (raw.order_status as GatewayOrderStatus) : 'UNKNOWN',
      amountPaise: Number.isFinite(amount) ? Math.round(amount * 100) : -1,
      paymentSessionId: typeof raw.payment_session_id === 'string' ? raw.payment_session_id : null,
    };
  }

  async createOrder(input: CreateGatewayOrderInput): Promise<GatewayOrder> {
    const raw = await this.call('POST', '/orders', {
      order_id: input.gatewayOrderId,
      order_amount: input.amountPaise / 100,
      order_currency: 'INR',
      customer_details: { customer_id: input.customerId, customer_phone: input.customerPhone },
      order_meta: { return_url: input.returnUrl, notify_url: input.notifyUrl },
      order_expiry_time: input.expiresAt.toISOString(),
    });
    return this.toOrder(raw);
  }

  async getOrder(gatewayOrderId: string): Promise<GatewayOrder | null> {
    try {
      return this.toOrder(await this.call('GET', `/orders/${encodeURIComponent(gatewayOrderId)}`));
    } catch (err) {
      if (err instanceof PaymentGatewayError && err.category === 'not_found') return null;
      throw err;
    }
  }

  async terminateOrder(gatewayOrderId: string): Promise<void> {
    try {
      await this.call('PATCH', `/orders/${encodeURIComponent(gatewayOrderId)}`, { order_status: 'TERMINATED' });
    } catch {
      // Best effort only: a later payment on a cancelled order is caught and flagged for refund.
    }
  }

  /** base64(HMAC-SHA256(timestamp + rawBody, secretKey)), compared in constant time. */
  verifyWebhookSignature(rawBody: string, timestamp: string, signature: string): boolean {
    if (!rawBody || !timestamp || !signature) return false;
    const expected = createHmac('sha256', this.config.secretKey).update(timestamp + rawBody).digest('base64');
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
