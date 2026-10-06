import { apiRequest } from '@/api/client';

/** Mirrors server/src/services/{driver,merchant}ProfileService.ts DTOs. Sensitive values arrive MASKED only. */
export type VerificationStatus = 'incomplete' | 'pending_review' | 'verified' | 'rejected';

export interface Address {
  line1: string;
  city: string;
  state?: string;
  pincode: string;
}

export interface Completeness {
  sections: Array<{ key: string; label: string; done: boolean; optional?: boolean }>;
  completed: number;
  total: number;
}

export interface BankView {
  accountHolderName: string;
  accountMasked: string | null;
  ifsc: string;
  bankName: string | null;
  upiId: string | null;
}

export interface DriverProfile {
  personal: { fullName: string; contactPhone: string; dateOfBirth: string; address: Address; emergencyContact: { name: string; phone: string } } | null;
  identity: { aadhaarMasked: string | null; panMasked: string | null; licenceMasked: string | null; licenceExpiry: string | null };
  vehicle: { type: string; registrationNumber: string; makeModel?: string } | null;
  bank: BankView | null;
  photos: { selfieUrl: string | null; vehicleUrl: string | null };
  kycStatus: VerificationStatus;
  bankStatus: VerificationStatus;
  /** Why the last review rejected this section (only while it is rejected), else null. */
  kycReviewNote: string | null;
  bankReviewNote: string | null;
  payoutReady: boolean;
  commissionBps: number | null;
  completeness: Completeness;
}

export interface MerchantProfile {
  personal: { shopName: string; ownerName: string; contactPhone: string; email?: string; address: Address } | null;
  identity: { panMasked: string | null; gstin: string | null; fssai: string | null };
  bank: BankView | null;
  pickupLocation: { latitude: number; longitude: number } | null;
  photoUrl: string | null;
  kycStatus: VerificationStatus;
  bankStatus: VerificationStatus;
  /** Why the last review rejected this section (only while it is rejected), else null. */
  kycReviewNote: string | null;
  bankReviewNote: string | null;
  payoutReady: boolean;
  commissionBps: number | null;
  completeness: Completeness;
}

export interface BankInput {
  accountHolderName: string;
  /** Omit to keep the stored number (the app only ever shows it masked). */
  accountNumber?: string;
  ifsc: string;
  bankName?: string;
  upiId?: string;
}

export interface DriverProfileInput {
  personal?: { fullName: string; contactPhone: string; dateOfBirth: string; address: Address; emergencyContact: { name: string; phone: string } };
  identity?: { aadhaarNumber?: string; panNumber?: string; licenceNumber?: string; licenceExpiry?: string };
  vehicle?: { type: string; registrationNumber: string; makeModel?: string };
  bank?: BankInput;
}

export interface MerchantProfileInput {
  personal?: { shopName: string; ownerName: string; contactPhone: string; email?: string; address: Address };
  identity?: { panNumber?: string; gstin?: string; fssai?: string };
  bank?: BankInput;
  pickupLocation?: { latitude: number; longitude: number };
}

export type PhotoKind = 'selfie' | 'vehicle' | 'shop';

export interface UploadGrant {
  uploadUrl: string;
  objectKey: string;
  headers: Record<string, string>;
  expiresInSeconds: number;
}

type Role = 'driver' | 'merchant';

export const getDriverProfile = () => apiRequest<DriverProfile>('/driver/profile');
export const saveDriverProfile = (input: DriverProfileInput) => apiRequest<DriverProfile>('/driver/profile', { method: 'PATCH', body: JSON.stringify(input) });
export const getMerchantProfile = () => apiRequest<MerchantProfile>('/merchant/profile');
export const saveMerchantProfile = (input: MerchantProfileInput) => apiRequest<MerchantProfile>('/merchant/profile', { method: 'PATCH', body: JSON.stringify(input) });

export const requestPhotoUpload = (role: Role, kind: PhotoKind, contentType: string, sizeBytes: number) =>
  apiRequest<UploadGrant>(`/${role}/profile/photo-upload`, { method: 'POST', body: JSON.stringify({ kind, contentType, sizeBytes }) });
export const confirmPhotoUpload = (role: Role, kind: PhotoKind, objectKey: string) =>
  apiRequest<null>(`/${role}/profile/photo-confirm`, { method: 'POST', body: JSON.stringify({ kind, objectKey }) });
export const removeProfilePhoto = (role: Role, kind: PhotoKind) => apiRequest<null>(`/${role}/profile/photo/${kind}`, { method: 'DELETE' });
