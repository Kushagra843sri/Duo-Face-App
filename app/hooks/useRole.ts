import { useState } from 'react';

import type { Role } from '@/types/auth';

interface RoleResolution {
  role: Role | null;
  isLoading: boolean;
}

// TODO(auth): wire this to the server's JWT-derived role once real authentication
// exists (Phase 2). It always reports an unresolved role until then.
export function useRole(): RoleResolution {
  const [state] = useState<RoleResolution>({ role: null, isLoading: false });
  return state;
}
