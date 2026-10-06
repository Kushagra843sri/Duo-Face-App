import type { RefundItem, RefundState } from '@/api/admin';
import type { Tone } from '@/constants/theme';

export const REFUND_STATE_LABEL: Record<RefundState, string> = {
  due: 'Needs refund',
  processing: 'In progress',
  failed: 'Failed, retry',
  refunded: 'Refunded',
};

export const REFUND_STATE_TONE: Record<RefundState, Tone> = {
  due: 'danger',
  processing: 'warn',
  failed: 'danger',
  refunded: 'success',
};

export const REFUND_REASON_LABEL: Record<RefundItem['reason'], string> = {
  rejected_by_shop: 'The shop rejected the order after it was paid',
  cancelled_after_payment: 'The order was cancelled or expired, but the payment still arrived',
  other: 'Refund needed',
};

/** Short, readable order reference (full ids are long and carry the customer id). */
export function shortOrderRef(orderId: string): string {
  const tail = orderId.slice(-6).toUpperCase();
  return `#${tail}`;
}
