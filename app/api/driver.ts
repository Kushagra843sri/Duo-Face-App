import { apiRequest } from '@/api/client';
import type { DeliveryOrder } from '@/api/deliveryOrder';

/** Mirrors GET /driver/me's response (server/src/routes/driver/index.ts). */
export interface DriverMe {
  firebaseUid: string;
  role: 'driver';
  driverId: string;
  name: string;
  phoneNumber?: string;
  status: 'active' | 'suspended';
}

/** Mirrors server/src/types/deliveryAssignment.ts (as serialized over JSON). */
export interface DriverAssignment {
  assignmentId: string;
  orderId: string;
  customerAppShopId: string;
  driverId: string;
  status: 'assigned' | 'accepted' | 'rejected' | 'picked_up' | 'delivered' | 'cancelled';
  assignedAt: string;
  acceptedAt?: string;
  rejectedAt?: string;
  pickedUpAt?: string;
  deliveredAt?: string;
  cancelledAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** Body of POST /driver/location. No driverId — the server uses the authenticated driver. */
export interface DriverLocationInput {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
  heading?: number;
  speedMps?: number;
}

/** Mirrors GET/POST /driver/location's response (server/src/routes/driver/location.ts). */
export interface DriverLocation extends DriverLocationInput {
  capturedAt: string | null;
  updatedAt: string | null;
  freshness: 'fresh' | 'stale';
}

export function getDriverLocation() {
  return apiRequest<DriverLocation>('/driver/location');
}

export function updateDriverLocation(input: DriverLocationInput) {
  return apiRequest<DriverLocation>('/driver/location', { method: 'POST', body: JSON.stringify(input) });
}

/** Mirrors POST/GET /driver/tracking/location (server/src/routes/driver/tracking.ts). */
export interface LiveTrackingLocation extends DriverLocationInput {
  capturedAt: string;
  freshness: 'fresh' | 'stale';
}

/** No driverId — the server derives the driver; assignmentId is verified against that driver's own assignments. */
export function publishTrackingLocation(assignmentId: string, input: DriverLocationInput) {
  return apiRequest<{ capturedAt: string }>('/driver/tracking/location', {
    method: 'POST',
    body: JSON.stringify({ assignmentId, ...input }),
  });
}

export function getTrackingLocation(assignmentId: string) {
  return apiRequest<LiveTrackingLocation>(`/driver/tracking/location/${encodeURIComponent(assignmentId)}`);
}

/** Tells the backend this driver stopped publishing (best effort; idempotent). */
export function stopTrackingLocation() {
  return apiRequest<null>('/driver/tracking/location', { method: 'DELETE' });
}

export function getDriverMe() {
  return apiRequest<DriverMe>('/driver/me');
}

export function getDriverAssignments() {
  return apiRequest<DriverAssignment[]>('/driver/assignments');
}

export function getDriverAssignment(assignmentId: string) {
  return apiRequest<DriverAssignment>(`/driver/assignments/${encodeURIComponent(assignmentId)}`);
}

export function getDriverAssignmentOrder(assignmentId: string) {
  return apiRequest<DeliveryOrder>(`/driver/assignments/${encodeURIComponent(assignmentId)}/order`);
}

export function acceptDriverAssignment(assignmentId: string) {
  return apiRequest<DriverAssignment>(`/driver/assignments/${encodeURIComponent(assignmentId)}/accept`, { method: 'POST' });
}

export function rejectDriverAssignment(assignmentId: string) {
  return apiRequest<DriverAssignment>(`/driver/assignments/${encodeURIComponent(assignmentId)}/reject`, { method: 'POST' });
}

export function pickupDriverAssignment(assignmentId: string) {
  return apiRequest<DriverAssignment>(`/driver/assignments/${encodeURIComponent(assignmentId)}/pickup`, { method: 'POST' });
}

/**
 * Exactly one proof of delivery (docs/decisions/028): a fresh GPS fix taken
 * at tap time (the server checks it is within 50 m of the customer), or the
 * customer's 6-digit code.
 */
export type DeliveryProof =
  | { location: { latitude: number; longitude: number; accuracyMeters?: number } }
  | { otp: string };

export function deliverDriverAssignment(assignmentId: string, proof: DeliveryProof) {
  return apiRequest<DriverAssignment>(`/driver/assignments/${encodeURIComponent(assignmentId)}/deliver`, {
    method: 'POST',
    body: JSON.stringify(proof),
  });
}

/**
 * The customer's number, released only when the server sees a fresh GPS fix within
 * 300 m of the delivery location while the order is picked up (docs/decisions/032).
 */
export function getCustomerContact(assignmentId: string, location: { latitude: number; longitude: number; accuracyMeters?: number }) {
  return apiRequest<{ phoneNumber: string }>(`/driver/assignments/${encodeURIComponent(assignmentId)}/customer-contact`, {
    method: 'POST',
    body: JSON.stringify({ location }),
  });
}

/** Mirrors GET/PUT /driver/duty (server/src/routes/driver/duty.ts). */
export interface DriverDuty {
  onDuty: boolean;
  dutyChangedAt: string | null;
}

export function getDriverDuty() {
  return apiRequest<DriverDuty>('/driver/duty');
}

/** No driverId — the server uses the authenticated driver. 409 when a delivery is still active. */
export function setDriverDuty(onDuty: boolean) {
  return apiRequest<DriverDuty>('/driver/duty', { method: 'PUT', body: JSON.stringify({ onDuty }) });
}
