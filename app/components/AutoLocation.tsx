import { useEffect } from 'react';

import { autoLocation } from '@/lib/autoLocation';

/**
 * Mounted once inside the authorized driver app. On open it asks for location
 * permission and starts keeping the stored location fresh by itself, with no
 * button (lib/autoLocation.ts). Renders nothing.
 */
export function AutoLocation() {
  useEffect(() => {
    void autoLocation.start();
    return () => autoLocation.stop();
  }, []);
  return null;
}
