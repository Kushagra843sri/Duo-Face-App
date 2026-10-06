import { apiRequest } from '@/api/client';
import type { DriverProfile, MerchantProfile, VerificationStatus } from '@/api/profile';

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

// ---- KYC / bank review ----

export type VerificationKind = 'driver' | 'merchant';
export type VerificationSection = 'kyc' | 'bank';

/** Mirrors server/src/services/profileVerificationService.ts. */
export interface VerificationQueueItem {
  kind: VerificationKind;
  ownerId: string;
  name: string;
  sections: { kyc: VerificationStatus; bank: VerificationStatus };
  pending: VerificationSection[];
  submittedAt: string | null;
}

export interface VerificationDetail {
  kind: VerificationKind;
  ownerId: string;
  name: string;
  /** Sent back with a decision: it is only applied if the profile is still exactly this version. */
  version: string;
  sections: { kyc: VerificationStatus; bank: VerificationStatus };
  /** Masked IDs and short-lived photo links, as the owner sees them. */
  profile: DriverProfile | MerchantProfile;
  licenceExpired: boolean;
  history: { section: VerificationSection; decision: 'approved' | 'rejected'; reason: string | null; at: string | null }[];
}

export const listVerifications = () => apiRequest<{ items: VerificationQueueItem[] }>('/admin/verifications').then((r) => r.items);

export const getVerification = (kind: VerificationKind, ownerId: string) =>
  apiRequest<{ verification: VerificationDetail }>(`/admin/verifications/${kind}/${encodeURIComponent(ownerId)}`).then((r) => r.verification);

export const decideVerification = (
  kind: VerificationKind,
  ownerId: string,
  section: VerificationSection,
  input: { decision: 'approve' | 'reject'; reason?: string; version: string }
) =>
  apiRequest<{ verification: VerificationDetail }>(`/admin/verifications/${kind}/${encodeURIComponent(ownerId)}/${section}`, {
    method: 'POST',
    body: JSON.stringify(input),
  }).then((r) => r.verification);
