import type { RefundItem } from '@/api/admin';
import { ApiError } from '@/api/errors';

/**
 * DEVELOPMENT-ONLY (lib/preview.ts): in-memory refunds so the admin screens can
 * be exercised without a backend. It mimics the server's rules loosely (full
 * amount only, a refund goes "processing" first and finishes on the next
 * check, no second refund) but it is NOT the server and moves no money.
 */
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const base = (orderId: string, shopName: string, reason: RefundItem['reason'], paid: number, minutesAgo: number): RefundItem => ({
  orderId,
  shopName,
  orderStatus: reason === 'rejected_by_shop' ? 'rejected' : 'cancelled',
  reason,
  deliveryPhone: '+919800000001',
  totalPaise: paid,
  paidAmountPaise: paid,
  createdAt: ago(minutesAgo),
  refund: { state: 'due', attempt: 0, requestedAt: null, requestedBy: null, processedAt: null },
});

const seeds: RefundItem[] = [
  base('ord_preview_A1B2C3', 'Fresh Mart', 'rejected_by_shop', 15950, 35),
  base('ord_preview_D4E5F6', 'Sharma Kirana', 'cancelled_after_payment', 4000, 120),
  {
    ...base('ord_preview_G7H8I9', 'Green Basket', 'rejected_by_shop', 28500, 300),
    refund: { state: 'refunded', attempt: 1, requestedAt: ago(280), requestedBy: 'preview-user', processedAt: ago(279) },
  },
];

const refunds = new Map<string, RefundItem>(seeds.map((r) => [r.orderId, r]));

const find = (id: string): RefundItem => {
  const r = refunds.get(id);
  if (!r) throw new ApiError(404, 'No refund found for this order.');
  return r;
};

export function adminPreviewRoute(method: string, seg: string[]): unknown {
  const [, area, id, action] = seg;
  if (seg[0] !== 'admin') throw new ApiError(404, 'Not found');
  if (area === 'me') return { firebaseUid: 'preview-user', role: 'admin' };
  if (area !== 'refunds') throw new ApiError(404, 'Not found');

  if (!id) {
    const all = [...refunds.values()];
    return { open: all.filter((r) => r.refund.state !== 'refunded'), refunded: all.filter((r) => r.refund.state === 'refunded') };
  }

  const item = find(id);
  if (method === 'GET') return { refund: item };

  if (action === 'refresh') {
    if (item.refund.state === 'processing') item.refund = { ...item.refund, state: 'refunded', processedAt: new Date().toISOString() };
    return { refund: item };
  }

  // start
  if (item.refund.state === 'refunded') throw new ApiError(409, 'This order has already been refunded.');
  if (item.refund.state === 'processing') return { refund: item };
  item.refund = { state: 'processing', attempt: item.refund.attempt + 1, requestedAt: new Date().toISOString(), requestedBy: 'preview-user', processedAt: null };
  return { refund: item };
}
