import { loadCashfreeConfig } from './config/cashfree';
import { CashfreeGateway } from './integrations/payments/CashfreeGateway';
import { CustomerOrderService } from './services/customerOrderService';
import { PaymentService } from './services/paymentService';
import { RefundService } from './services/refundService';

/**
 * The one place online payment is assembled from the environment. With no
 * Cashfree settings everything is null/disabled: cash on delivery still works
 * and online checkout answers 503.
 */
export const cashfreeConfig = loadCashfreeConfig();
export const paymentGateway = cashfreeConfig ? new CashfreeGateway(cashfreeConfig) : null;
export const customerOrderService = new CustomerOrderService(undefined, undefined, paymentGateway);
export const paymentService = new PaymentService(customerOrderService, paymentGateway, cashfreeConfig?.publicBaseUrl ?? null);
export const refundService = new RefundService(paymentGateway);
