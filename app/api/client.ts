import { ApiError, NetworkError } from '@/api/errors';
import { authService } from '@/lib/authService';
import { env } from '@/lib/env';
import { previewRole } from '@/lib/preview';
import { previewRequest } from '@/lib/previewData';

// Error classes live in api/errors.ts (so lib/previewData.ts can use them without an import cycle).
export { ApiError, NetworkError } from '@/api/errors';

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  // Development UI preview only (lib/preview.ts): sample data, no network, null in production builds.
  if (previewRole) return previewRequest<T>(previewRole, path, init);

  const token = await authService.getIdToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  let response: Response;
  try {
    response = await fetch(`${env.apiUrl}${path}`, { ...init, headers });
  } catch {
    throw new NetworkError();
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const parsed = body as { message?: string; error?: string } | null;
    throw new ApiError(response.status, parsed?.message ?? `Request failed with status ${response.status}`, parsed?.error);
  }

  return body as T;
}
