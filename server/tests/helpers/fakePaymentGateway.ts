import { createHmac } from 'node:crypto';

import { CashfreeGateway, PaymentGatewayError } from '../../src/integrations/payments/CashfreeGateway';
import type {
  CreateGatewayOrderInput,
  CreateGatewayRefundInput,
  GatewayOrder,
  GatewayRefund,
  PaymentGateway,
} from '../../src/integrations/payments/CashfreeGateway';

export const TEST_SECRET = 'test-secret';
const realSigner = new CashfreeGateway({ appId: 'a', secretKey: TEST_SECRET, env: 'sandbox', publicBaseUrl: 'https://api.example.com' });
export const signWebhook = (raw: string, ts = '1760000000000') => ({ ts, sig: createHmac('sha256', TEST_SECRET).update(ts + raw).digest('base64') });

/** In-memory stand-in for Cashfree orders (payment flow tests). */
export class FakeGateway implements PaymentGateway {
  readonly mode = 'sandbox' as const;
  orders = new Map<string, GatewayOrder>();
  created: CreateGatewayOrderInput[] = [];
  terminated: string[] = [];
  down = false;

  async createOrder(input: CreateGatewayOrderInput): Promise<GatewayOrder> {
    if (this.down) throw new PaymentGatewayError('transient');
    if (this.orders.has(input.gatewayOrderId)) throw new PaymentGatewayError('rejected', 409);
    const g: GatewayOrder = { status: 'ACTIVE', amountPaise: input.amountPaise, paymentSessionId: `session_${this.created.length}_abcdefgh` };
    this.orders.set(input.gatewayOrderId, g);
    this.created.push(input);
    return { ...g };
  }
  async getOrder(id: string) {
    if (this.down) throw new PaymentGatewayError('transient');
    const g = this.orders.get(id);
    return g ? { ...g } : null;
  }
  async createRefund(_input: CreateGatewayRefundInput): Promise<GatewayRefund> {
    throw new Error('not used in payment tests');
  }
  async getRefund(): Promise<GatewayRefund | null> {
    throw new Error('not used in payment tests');
  }
  async terminateOrder(id: string) {
    this.terminated.push(id);
    const g = this.orders.get(id);
    if (g?.status === 'ACTIVE') g.status = 'TERMINATED';
  }
  verifyWebhookSignature(raw: string, ts: string, sig: string) {
    return realSigner.verifyWebhookSignature(raw, ts, sig);
  }
  pay(id: string, amountPaise?: number) {
    const g = this.orders.get(id)!;
    g.status = 'PAID';
    if (amountPaise !== undefined) g.amountPaise = amountPaise;
  }
}
