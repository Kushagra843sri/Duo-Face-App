import { apiRequest } from '@/api/client';
import type { Role } from '@/types/auth';

/** Mirrors the server's strict registerBodySchema (server/src/services/registrationService.ts). */
export type RegisterRequest = { intent: 'driver'; name: string } | { intent: 'merchant'; shopName: string };

/** POST /auth/register. The server records the role; the app re-resolves it via GET /auth/me afterwards. */
export function registerAccount(body: RegisterRequest) {
  return apiRequest<{ role: Role }>('/auth/register', { method: 'POST', body: JSON.stringify(body) });
}
