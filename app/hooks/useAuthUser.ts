import { useEffect, useState } from 'react';

import { authService } from '@/lib/authService';
import type { AuthUser } from '@/lib/authService';

/**
 * Tracks the Firebase session. `isInitializing` stays true until the SDK
 * has reported its first state (restored session or none), so callers
 * never mistake "not restored yet" for "signed out".
 */
export function useAuthUser() {
  const [state, setState] = useState<{ user: AuthUser | null; isInitializing: boolean }>({
    user: null,
    isInitializing: true,
  });

  useEffect(
    () =>
      authService.subscribe((user) => {
        setState({ user, isInitializing: false });
      }),
    []
  );

  return state;
}
