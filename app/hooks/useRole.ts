import { useEffect, useState } from 'react';

import { getAuthMe } from '@/api/auth';
import { ApiError, NetworkError } from '@/api/client';
import type { Role } from '@/types/auth';

interface RoleResolution {
  role: Role | null;
  isLoading: boolean;
  /** A genuine network failure (backend unreachable). */
  error: NetworkError | null;
  /**
   * The backend answered but gave no role: 401 (session rejected) or 403
   * (authenticated but not mapped to a merchant/driver). Kept distinct
   * from `error` so the UI can explain it and offer sign-out.
   */
  denied: ApiError | null;
  retry: () => void;
}

/**
 * The backend is the sole authority on role — this calls GET /auth/me for
 * real, with the Firebase ID token supplied by apiRequest(). It must only
 * be used while a Firebase user exists (`userId` is that user's uid; it
 * exists solely to re-resolve when the signed-in user changes). Nothing is
 * read from local storage and the client never chooses its role.
 */
export function useRole(userId: string | null): RoleResolution {
  const [state, setState] = useState<Omit<RoleResolution, 'retry'>>({
    role: null,
    isLoading: userId !== null,
    error: null,
    denied: null,
  });
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (userId === null) {
      setState({ role: null, isLoading: false, error: null, denied: null });
      return;
    }

    let cancelled = false;
    setState({ role: null, isLoading: true, error: null, denied: null });

    getAuthMe()
      .then((principal) => {
        if (!cancelled) setState({ role: principal.role, isLoading: false, error: null, denied: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError) {
          setState({ role: null, isLoading: false, error: null, denied: err });
        } else if (err instanceof NetworkError) {
          setState({ role: null, isLoading: false, error: err, denied: null });
        } else {
          setState({ role: null, isLoading: false, error: null, denied: new ApiError(0, 'Could not resolve your role.') });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [userId, retryCount]);

  return { ...state, retry: () => setRetryCount((count) => count + 1) };
}
