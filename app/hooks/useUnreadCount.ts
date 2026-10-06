import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { getInbox } from '@/api/notifications';

/** How often the bell re-checks while the app is open (push covers the rest). */
const POLL_MS = 30_000;

/**
 * Unread notification count for the bell. Best effort: a failed check keeps
 * the last known number (the bell never shows an error).
 */
export function useUnreadCount() {
  const [unread, setUnread] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setUnread((await getInbox()).unread);
    } catch {
      // keep the last value
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0);
    const timer = setInterval(() => void refresh(), POLL_MS);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => {
      clearTimeout(first);
      clearInterval(timer);
      sub.remove();
    };
  }, [refresh]);

  return { unread, refresh };
}
