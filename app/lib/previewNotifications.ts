import { ApiError } from '@/api/errors';
import type { PreviewRole } from '@/lib/preview';

/**
 * DEVELOPMENT-ONLY (lib/preview.ts): a sample inbox per role so the bell and
 * inbox can be exercised without a backend. Same wording as the server.
 */
interface Note {
  id: string;
  type: string;
  title: string;
  body: string;
  orderId: string | null;
  createdAt: string;
  read: boolean;
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const SEEDS: Record<PreviewRole, Note[]> = {
  merchant: [
    { id: 'new_order:order-1001', type: 'new_order', title: 'New order', body: 'You have a new order. Open the app to accept it.', orderId: 'order-1001', createdAt: ago(3), read: false },
    { id: 'shop_driver_accepted:a-1', type: 'shop_driver_accepted', title: 'Delivery partner on the way', body: 'A delivery partner accepted the pickup for an order.', orderId: 'order-1002', createdAt: ago(45), read: true },
  ],
  driver: [
    { id: 'new_delivery_offer:a-1', type: 'new_delivery_offer', title: 'New delivery offer', body: 'You have a new delivery request. Open the app to accept it.', orderId: 'order-1001', createdAt: ago(2), read: false },
  ],
  admin: [
    { id: 'admin_refund_due:ord_preview_A1B2C3', type: 'admin_refund_due', title: 'Refund needed', body: 'An order needs a refund. Open the app to review it.', orderId: 'ord_preview_A1B2C3', createdAt: ago(10), read: false },
    { id: 'admin_kyc_submitted:driver:d-1:1', type: 'admin_kyc_submitted', title: 'Verification to review', body: 'A driver or shop submitted documents for review.', orderId: null, createdAt: ago(25), read: false },
  ],
};

const boxes = new Map<PreviewRole, Note[]>();
const box = (role: PreviewRole) => {
  if (!boxes.has(role)) boxes.set(role, SEEDS[role].map((n) => ({ ...n })));
  return boxes.get(role)!;
};

/** Returns undefined when the path is not a notifications path. */
export function previewNotificationsRoute(role: PreviewRole, method: string, path: string): unknown | undefined {
  if (!path.startsWith('/notifications')) return undefined;
  const notes = box(role);
  if (path === '/notifications' && method === 'GET') {
    return { notifications: [...notes].sort((a, b) => b.createdAt.localeCompare(a.createdAt)), unread: notes.filter((n) => !n.read).length };
  }
  if (path === '/notifications/read-all') {
    const marked = notes.filter((n) => !n.read).length;
    notes.forEach((n) => (n.read = true));
    return { marked };
  }
  const one = path.match(/^\/notifications\/([^/]+)\/read$/);
  if (one) {
    const n = notes.find((x) => x.id === decodeURIComponent(one[1]));
    if (!n) throw new ApiError(404, 'Notification not found.');
    n.read = true;
    return null;
  }
  if (path.startsWith('/notifications/device')) return null;
  throw new ApiError(404, 'Not found');
}
