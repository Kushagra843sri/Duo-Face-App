import type { VerificationDetail, VerificationQueueItem } from '@/api/admin';
import { ApiError } from '@/api/errors';
import type { DriverProfile, MerchantProfile, VerificationStatus } from '@/api/profile';

/**
 * DEVELOPMENT-ONLY (lib/preview.ts): sample KYC reviews so the admin review
 * screens can be exercised without a backend. It mimics the server's rules
 * (only a section in review can be decided, a stale version is refused, a
 * rejection needs a reason) but it is NOT the server.
 */
const photo = (label: string, color: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300"><rect width="480" height="300" fill="${color}"/><text x="240" y="160" font-size="30" text-anchor="middle" fill="white" font-family="sans-serif">${label} (sample)</text></svg>`
  )}`;

const completeness = { sections: [], completed: 5, total: 5 };

interface Review {
  detail: VerificationDetail;
  submittedMinutesAgo: number;
}

const driverProfile: DriverProfile = {
  personal: {
    fullName: 'Ravi Kumar',
    contactPhone: '+919876543210',
    dateOfBirth: '1995-04-12',
    address: { line1: '14 Park Road', city: 'Delhi', pincode: '110016' },
    emergencyContact: { name: 'Sunita Kumar', phone: '+919876500000' },
  },
  identity: { aadhaarMasked: 'XXXX-XXXX-9012', panMasked: '••••••234F', licenceMasked: '•••••••••••2345', licenceExpiry: '2029-08-30' },
  vehicle: { type: 'motorcycle', registrationNumber: 'DL1AB1234', makeModel: 'Honda Shine' },
  bank: { accountHolderName: 'Ravi Kumar', accountMasked: '••••9012', ifsc: 'SBIN0001234', bankName: 'SBI', upiId: 'ravi@oksbi' },
  photos: { selfieUrl: photo('Selfie', '#4f46e5'), vehicleUrl: photo('Vehicle', '#0f766e') },
  kycStatus: 'pending_review',
  bankStatus: 'pending_review',
  kycReviewNote: null,
  bankReviewNote: null,
  payoutReady: false,
  commissionBps: 1000,
  completeness,
};

const merchantProfile: MerchantProfile = {
  personal: {
    shopName: 'Fresh Mart',
    ownerName: 'Anil Sharma',
    contactPhone: '+919822200001',
    email: 'anil@example.com',
    address: { line1: '5 Market Road', city: 'Delhi', pincode: '110016' },
  },
  identity: { panMasked: '••••••234F', gstin: '27AAPFU0939F1ZV', fssai: '98765432109876' },
  bank: null,
  pickupLocation: { latitude: 28.5583, longitude: 77.2028 },
  photoUrl: null,
  kycStatus: 'pending_review',
  bankStatus: 'incomplete',
  kycReviewNote: null,
  bankReviewNote: null,
  payoutReady: false,
  commissionBps: 1000,
  completeness,
};

const reviews = new Map<string, Review>([
  [
    'driver:d-1',
    {
      submittedMinutesAgo: 90,
      detail: {
        kind: 'driver',
        ownerId: 'd-1',
        name: 'Ravi Kumar',
        version: '1760000000001',
        sections: { kyc: 'pending_review', bank: 'pending_review' },
        licenceExpired: false,
        history: [],
        profile: driverProfile,
      },
    },
  ],
  [
    'merchant:s-1',
    {
      submittedMinutesAgo: 30,
      detail: {
        kind: 'merchant',
        ownerId: 's-1',
        name: 'Fresh Mart',
        version: '1760000000002',
        sections: { kyc: 'pending_review', bank: 'incomplete' },
        licenceExpired: false,
        history: [{ section: 'kyc', decision: 'rejected', reason: 'The FSSAI number did not match the shop name.', at: new Date(Date.now() - 86_400_000).toISOString() }],
        profile: merchantProfile,
      },
    },
  ],
]);

/** seg = ['admin', 'verifications', kind?, ownerId?, section?] */
export function adminVerificationRoute(method: string, seg: string[], body: Record<string, unknown>): unknown {
  const [, , kind, ownerId, section] = seg;

  if (!kind) {
    const items: VerificationQueueItem[] = [...reviews.values()]
      .filter((r) => r.detail.sections.kyc === 'pending_review' || r.detail.sections.bank === 'pending_review')
      .map((r) => ({
        kind: r.detail.kind,
        ownerId: r.detail.ownerId,
        name: r.detail.name || 'Unnamed',
        sections: r.detail.sections,
        pending: (['kyc', 'bank'] as const).filter((s) => r.detail.sections[s] === 'pending_review'),
        submittedAt: new Date(Date.now() - r.submittedMinutesAgo * 60_000).toISOString(),
      }))
      .sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''));
    return { items };
  }

  const review = reviews.get(`${kind}:${ownerId}`);
  if (!review) throw new ApiError(404, 'Profile not found.');
  if (method === 'GET') return { verification: review.detail };

  const sec = section === 'bank' ? 'bank' : 'kyc';
  if (review.detail.sections[sec] !== 'pending_review') throw new ApiError(409, 'This section is not waiting for review.');
  if (body.version !== review.detail.version) {
    throw new ApiError(409, 'This profile changed since you opened it. Open it again and review the latest details.');
  }
  const approve = body.decision === 'approve';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!approve && (reason.length < 3 || reason.length > 200)) {
    throw new ApiError(400, 'Give a reason (3 to 200 characters) so the person knows what to fix.');
  }

  const status: VerificationStatus = approve ? 'verified' : 'rejected';
  review.detail = {
    ...review.detail,
    version: String(Number(review.detail.version) + 1),
    sections: { ...review.detail.sections, [sec]: status },
    history: [
      { section: sec, decision: approve ? 'approved' : 'rejected', reason: approve ? null : reason, at: new Date().toISOString() },
      ...review.detail.history,
    ],
  };
  return { verification: review.detail };
}
