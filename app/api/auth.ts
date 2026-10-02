import { apiRequest } from '@/api/client';
import type { Role } from '@/types/auth';

/** Mirrors the server's AuthenticatedPrincipal (server/src/types/auth.ts). */
export interface AuthMePrincipal {
  firebaseUid: string;
  role: Role;
  shopId?: string;
  driverId?: string;
}

export function getAuthMe() {
  return apiRequest<AuthMePrincipal>('/auth/me');
}
