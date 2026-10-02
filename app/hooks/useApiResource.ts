import { useEffect, useRef, useState } from 'react';

interface ApiResourceState<T> {
  data: T | null;
  isLoading: boolean;
  error: unknown;
}

/**
 * Fetches once on mount and exposes {data, isLoading, error, retry} — the
 * one place loading/error/retry logic lives, so screens don't reimplement
 * it. `fetcher` can safely be a fresh inline arrow function on every
 * render: a ref always holds the latest one, but the effect itself only
 * re-runs when `retry()` bumps the internal counter or a caller-supplied
 * dep changes — never on every render.
 */
export function useApiResource<T>(fetcher: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<ApiResourceState<T>>({ data: null, isLoading: true, error: null });
  const [retryCount, setRetryCount] = useState(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ ...prev, isLoading: true, error: null }));

    fetcherRef
      .current()
      .then((data) => {
        if (!cancelled) setState({ data, isLoading: false, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ data: null, isLoading: false, error });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [retryCount, ...deps]);

  return { ...state, retry: () => setRetryCount((count) => count + 1) };
}
