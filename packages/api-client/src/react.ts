/**
 * React bindings. A separate entry point so the core package stays framework
 * free and an application that only needs the client never pulls React into
 * its bundle.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AuthTokenProvider } from './client.js';
import {
  invalidateQueries,
  subscribeToRefetch,
  type QueryKey,
} from './refetch-registry.js';

/** Polling interval used when `intervalMs` is not given. */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** Ceiling on the error backoff when `maxBackoffMs` is not given. */
export const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;

/** What a fetcher receives. The signal aborts on unmount and on a supersede. */
export interface PolledQueryContext {
  /** Abort signal for the request. Pass it straight to the client. */
  signal: AbortSignal;
}

/** Reads the data. Receives a signal and should honour it. */
export type PolledQueryFetcher<T> = (context: PolledQueryContext) => Promise<T>;

/** Options for {@link usePolledQuery}. */
export interface PolledQueryOptions {
  /**
   * Milliseconds between polls, measured from the end of one fetch to the
   * start of the next. Defaults to {@link DEFAULT_POLL_INTERVAL_MS}.
   */
  intervalMs?: number;
  /**
   * Whether the query runs at all. False stops the timer, drops any pending
   * backoff and aborts an in-flight request, while keeping the last data on
   * screen so a disabled panel does not blink empty.
   */
  enabled?: boolean;
  /** Refetches when the window regains focus. Defaults to true. */
  refetchOnFocus?: boolean;
  /**
   * Pauses polling while the document is hidden and refetches on the way back
   * to visible. Defaults to true. A background tab that polls is a bill and a
   * battery drain for data nobody is reading.
   */
  refetchOnVisible?: boolean;
  /** Ceiling on the error backoff. Defaults to {@link DEFAULT_MAX_BACKOFF_MS}. */
  maxBackoffMs?: number;
  /**
   * Milliseconds after which {@link PolledQueryResult.isStale} reads true.
   * Defaults to `intervalMs`, so data is stale once its replacement is due.
   */
  staleTimeMs?: number;
  /**
   * The key other call sites invalidate to force this query to refetch. Also
   * what {@link useMutationWithRefetch} names.
   */
  queryKey?: QueryKey;
  /**
   * The auth provider the client was built with. When it exposes
   * `waitForToken`, the first fetch waits on it, so a query mounted during boot
   * reads with the restored session rather than going out anonymous and
   * rendering a 401.
   */
  auth?: Pick<AuthTokenProvider, 'waitForToken'>;
}

/** What {@link usePolledQuery} returns. */
export interface PolledQueryResult<T> {
  /** The last successful value, or null before the first one lands. */
  data: T | null;
  /** The last failure, or null. Cleared by the next success. */
  error: unknown;
  /** True until the first fetch settles. Gate a skeleton on this. */
  isLoading: boolean;
  /** True while any fetch is in flight, the first one included. */
  isFetching: boolean;
  /** Whether the data is older than `staleTimeMs`. */
  isStale: boolean;
  /** When the last success landed, in epoch milliseconds, or null. */
  lastUpdatedAt: number | null;
  /**
   * Fetches now, resetting the interval and any backoff. De-duplicated against
   * an in-flight fetch: calling it while one is running returns that one rather
   * than starting a second.
   */
  refetch: () => Promise<void>;
}

/** Fractional jitter applied to a backoff delay, as a proportion of it. */
const BACKOFF_JITTER = 0.5;

/** Whether the document is currently visible. True outside a browser. */
function documentVisible(): boolean {
  if (typeof document === 'undefined') {
    return true;
  }
  return document.visibilityState !== 'hidden';
}

/**
 * Polls a fetcher on an interval and keeps the result in state.
 *
 * Dependency free: no react-query, no cache and no shared store beyond the
 * refetch keys, because the applications need a handful of live panels rather
 * than a query layer.
 *
 * The timer is a chained `setTimeout` rather than `setInterval`, measured from
 * the end of one fetch to the start of the next, so a fetch slower than the
 * interval cannot stack requests behind itself.
 *
 * A failure backs off exponentially from the interval with full jitter up to
 * `maxBackoffMs`, and a success resets it. `data` is left alone by a failure,
 * so a panel keeps showing the last good value with the error beside it.
 *
 * @example
 * ```ts
 * const { data, isStale, refetch } = usePolledQuery(
 *   ({ signal }) => client.get<Job[]>('/jobs/', { signal }).then((r) => r.data),
 *   { intervalMs: 10_000, queryKey: 'jobs', auth }
 * );
 * ```
 */
export function usePolledQuery<T>(
  fetcher: PolledQueryFetcher<T>,
  options: PolledQueryOptions = {}
): PolledQueryResult<T> {
  const {
    intervalMs = DEFAULT_POLL_INTERVAL_MS,
    enabled = true,
    refetchOnFocus = true,
    refetchOnVisible = true,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    staleTimeMs = intervalMs,
    queryKey,
    auth,
  } = options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [isFetching, setIsFetching] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [staleAt, setStaleAt] = useState<number | null>(null);

  const live = useRef(true);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const authRef = useRef(auth);
  authRef.current = auth;

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  const inFlight = useRef<Promise<void> | undefined>(undefined);
  const failures = useRef(0);
  const waited = useRef(false);

  const clearTimer = useCallback((): void => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, []);

  /**
   * The wait before the next poll: the interval when the last fetch succeeded,
   * and an exponential backoff with full jitter once it has not.
   */
  const nextDelay = useCallback((): number => {
    if (failures.current === 0) {
      return intervalMs;
    }
    const ceiling = Math.min(intervalMs * 2 ** failures.current, maxBackoffMs);
    return ceiling * (1 - BACKOFF_JITTER + Math.random() * BACKOFF_JITTER);
  }, [intervalMs, maxBackoffMs]);

  /** Everything the run loop needs, read through a ref to keep `run` stable. */
  const settings = useRef({
    enabled,
    intervalMs,
    staleTimeMs,
    refetchOnVisible,
  });
  settings.current = { enabled, intervalMs, staleTimeMs, refetchOnVisible };

  const schedule = useRef<() => void>(() => undefined);

  /**
   * One fetch. De-duplication is the `inFlight` promise: a concurrent caller
   * is handed the running one, so a focus event landing on top of an interval
   * tick does not double the request.
   */
  const run = useCallback((): Promise<void> => {
    if (inFlight.current !== undefined) {
      return inFlight.current;
    }
    const abort = new AbortController();
    controller.current = abort;
    setIsFetching(true);

    const attempt = (async (): Promise<void> => {
      try {
        const waitForToken = authRef.current?.waitForToken;
        if (waitForToken !== undefined && !waited.current) {
          waited.current = true;
          await waitForToken.call(authRef.current);
        }
        if (abort.signal.aborted) {
          return;
        }
        const value = await fetcherRef.current({ signal: abort.signal });
        if (!live.current || abort.signal.aborted) {
          return;
        }
        failures.current = 0;
        const now = Date.now();
        setData(value);
        setError(null);
        setLastUpdatedAt(now);
        setStaleAt(now + settings.current.staleTimeMs);
      } catch (thrown) {
        if (!live.current || abort.signal.aborted) {
          return;
        }
        failures.current += 1;
        setError(thrown);
      } finally {
        inFlight.current = undefined;
        if (live.current && controller.current === abort) {
          controller.current = undefined;
          setIsFetching(false);
          setIsLoading(false);
        }
      }
      if (live.current && settings.current.enabled) {
        schedule.current();
      }
    })();

    inFlight.current = attempt;
    return attempt;
  }, []);

  schedule.current = useCallback((): void => {
    clearTimer();
    if (!settings.current.enabled) {
      return;
    }
    if (settings.current.refetchOnVisible && !documentVisible()) {
      return;
    }
    timer.current = setTimeout(() => {
      timer.current = undefined;
      if (live.current && settings.current.enabled) {
        void run();
      }
    }, nextDelay());
  }, [clearTimer, nextDelay, run]);

  const refetch = useCallback((): Promise<void> => {
    failures.current = 0;
    clearTimer();
    return run();
  }, [clearTimer, run]);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      clearTimer();
      controller.current?.abort();
      controller.current = undefined;
      inFlight.current = undefined;
    };
  }, [clearTimer]);

  useEffect(() => {
    if (!enabled) {
      clearTimer();
      controller.current?.abort();
      controller.current = undefined;
      inFlight.current = undefined;
      failures.current = 0;
      setIsFetching(false);
      return;
    }
    void run();
    return clearTimer;
  }, [enabled, intervalMs, clearTimer, run]);

  useEffect(() => {
    if (!enabled || queryKey === undefined) {
      return;
    }
    return subscribeToRefetch(queryKey, () => {
      void refetch();
    });
  }, [enabled, queryKey, refetch]);

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') {
      return;
    }
    const onFocus = (): void => {
      if (refetchOnFocus) {
        void run();
      }
    };
    const onVisibility = (): void => {
      if (!refetchOnVisible) {
        return;
      }
      if (documentVisible()) {
        void run();
      } else {
        clearTimer();
      }
    };
    if (refetchOnFocus) {
      window.addEventListener('focus', onFocus);
    }
    if (refetchOnVisible && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibility);
    }
    return () => {
      window.removeEventListener('focus', onFocus);
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
    };
  }, [enabled, refetchOnFocus, refetchOnVisible, clearTimer, run]);

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (staleAt === null) {
      return;
    }
    const remaining = staleAt - Date.now();
    if (remaining <= 0) {
      setNow(Date.now());
      return;
    }
    const staleTimer = setTimeout(() => {
      setNow(Date.now());
    }, remaining);
    return () => {
      clearTimeout(staleTimer);
    };
  }, [staleAt]);

  const isStale = staleAt === null ? data !== null : now >= staleAt;

  return useMemo(
    () => ({
      data,
      error,
      isLoading,
      isFetching,
      isStale,
      lastUpdatedAt,
      refetch,
    }),
    [data, error, isLoading, isFetching, isStale, lastUpdatedAt, refetch]
  );
}

/** What {@link useMutationWithRefetch} returns. */
export interface MutationWithRefetch<TArgs extends unknown[], TResult> {
  /**
   * Runs the write, then invalidates the keys so the queries reading them
   * refetch immediately. Rejects exactly as the write does, and invalidates
   * nothing when it rejects.
   */
  mutate: (...args: TArgs) => Promise<TResult>;
  /** True while the write is in flight. */
  isMutating: boolean;
  /** The last failure, or null. Cleared when the next write starts. */
  error: unknown;
}

/**
 * Wraps a write so that its related polled queries refetch the moment it
 * lands, rather than waiting out the rest of their interval.
 *
 * The invalidation is a notification, not a cache write: each listening query
 * goes and reads again, so the server stays the only source of truth and a
 * write does not have to know the shape of what the queries hold.
 *
 * @example
 * ```ts
 * const { mutate, isMutating } = useMutationWithRefetch(
 *   (name: string) => client.post('/jobs/', { name }),
 *   'jobs'
 * );
 * ```
 */
export function useMutationWithRefetch<TArgs extends unknown[], TResult>(
  write: (...args: TArgs) => Promise<TResult>,
  keys: QueryKey | readonly QueryKey[]
): MutationWithRefetch<TArgs, TResult> {
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const live = useRef(true);
  const writeRef = useRef(write);
  writeRef.current = write;
  const keysRef = useRef(keys);
  keysRef.current = keys;

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const mutate = useCallback(async (...args: TArgs): Promise<TResult> => {
    setIsMutating(true);
    setError(null);
    try {
      const result = await writeRef.current(...args);
      invalidateQueries(keysRef.current);
      return result;
    } catch (thrown) {
      if (live.current) {
        setError(thrown);
      }
      throw thrown;
    } finally {
      if (live.current) {
        setIsMutating(false);
      }
    }
  }, []);

  return useMemo(
    () => ({ mutate, isMutating, error }),
    [mutate, isMutating, error]
  );
}

export {
  invalidateQueries,
  subscribeToRefetch,
  type QueryKey,
  type Unsubscribe,
} from './refetch-registry.js';
