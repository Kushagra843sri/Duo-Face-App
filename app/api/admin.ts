import { apiRequest } from '@/api/client';

/** Mirrors GET /admin/me (server/src/routes/admin/index.ts). */
export interface AdminMe {
  firebaseUid: string;
  role: 'admin';
}

export type RefundState = 'due' | 'processing' | 'failed' | 'refunded';

/** Mirrors server/src/services/refundService.ts RefundView. Money is integer paise. */
export interface RefundItem {
  orderId: string;
  shopName: string;
  orderStatus: string;
  reason: 'rejected_by_shop' | 'cancelled_after_payment' | 'other';
  deliveryPhone: string;
  totalPaise: number;
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

export const getAdminMe = () => apiRequest<AdminMe>('/admin/me');

export const listRefunds = () => apiRequest<{ open: RefundItem[]; refunded: RefundItem[] }>('/admin/refunds');

export const getRefund = (orderId: string) =>
  apiRequest<{ refund: RefundItem }>(`/admin/refunds/${encodeURIComponent(orderId)}`).then((r) => r.refund);

/** Refunds the FULL amount paid. There is deliberately no amount to send. */
export const startRefund = (orderId: string) =>
  apiRequest<{ refund: RefundItem }>(`/admin/refunds/${encodeURIComponent(orderId)}`, { method: 'POST' }).then((r) => r.refund);

/** Asks the server to check a processing refund with the payment provider. */
export const refreshRefund = (orderId: string) =>
  apiRequest<{ refund: RefundItem }>(`/admin/refunds/${encodeURIComponent(orderId)}/refresh`, { method: 'POST' }).then((r) => r.refund);
