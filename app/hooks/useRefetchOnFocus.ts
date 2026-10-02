import { useFocusEffect } from 'expo-router';
import { useCallback, useRef } from 'react';

/**
 * Re-runs a useApiResource fetch whenever the screen regains focus (e.g.
 * coming back from the assign-driver flow), skipping the initial focus
 * because the hook already fetches on mount. `retry` is held in a ref so
 * its changing identity can't retrigger the focus effect.
 */
export function useRefetchOnFocus(retry: () => void) {
  const retryRef = useRef(retry);
  retryRef.current = retry;
  const isFirstFocus = useRef(true);

  useFocusEffect(
    useCallback(() => {
      if (isFirstFocus.current) {
        isFirstFocus.current = false;
        return;
      }
      retryRef.current();
    }, [])
  );
}
