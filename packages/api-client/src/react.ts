/**
 * React bindings. A separate entry point so the core package stays framework
 * free and an application that only needs the client never pulls React into
 * its bundle.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { AuthTokenProvider } from './client.js';
import {
  invalidateQueries,
  serializeQueryKey,
  subscribeToRefetch,
  type QueryKey,
} from './refetch-registry.js';

/** Polling interval used when `intervalMs` is not given. */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

/** Ceiling on the error backoff when `maxBackoffMs` is not given. */
export const DEFAULT_MAX_BACKOFF_MS = 15_000;

/** Deadline on one whole poll attempt when `attemptTimeoutMs` is not given. */
export const DEFAULT_ATTEMPT_TIMEOUT_MS = 30_000;

/**
 * What a poll attempt rejects with when it outlives `attemptTimeoutMs`. It
 * lands in {@link PolledQueryResult.error} and counts as a failure for backoff.
 */
export class PolledQueryTimeoutError extends Error {
  /** The deadline the attempt exceeded, in milliseconds. */
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Poll attempt timed out after ${String(timeoutMs)}ms.`);
    this.name = 'PolledQueryTimeoutError';
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, PolledQueryTimeoutError.prototype);
  }
}

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
  /**
   * Ceiling on the error backoff. Defaults to {@link DEFAULT_MAX_BACKOFF_MS}.
   * The backoff never drops below `intervalMs`, so a failing query is never
   * polled faster than a healthy one.
   */
  maxBackoffMs?: number;
  /**
   * Deadline on one whole attempt: the `waitForToken` wait and the fetcher,
   * which covers any token refresh, the request and reading the body. An
   * attempt that outlives it is aborted through its signal, rejects with
   * {@link PolledQueryTimeoutError} and the next poll starts a new attempt.
   * Defaults to {@link DEFAULT_ATTEMPT_TIMEOUT_MS}. 0 disables it.
   */
  attemptTimeoutMs?: number;
  /**
   * Milliseconds without an attempt starting or settling after which the
   * watchdog restarts polling, aborting anything still in flight. It only fires
   * while the document is visible, and checks again as soon as the document
   * returns to visible. Defaults to the longest healthy gap between attempts,
   * `max(intervalMs, maxBackoffMs)` plus the attempt deadline, so it fires only
   * when the poll loop has stalled. 0 disables it.
   */
  stallTimeoutMs?: number;
  /**
   * Milliseconds after which {@link PolledQueryResult.isStale} reads true.
   * Defaults to `intervalMs`, so data is stale once its replacement is due.
   */
  staleTimeMs?: number;
  /**
   * The key naming the data this query reads. Other call sites invalidate it to
   * force a refetch, and it is what {@link useMutationWithRefetch} names.
   *
   * It also identifies the query: changing it starts a fresh one. Put the
   * filters, the page cursor and anything else the fetcher closes over in the
   * key, as `['jobs', page, status]`, and the hook re-reads when they change.
   * The key is compared by a stable serialisation rather than by identity, so
   * an array built inline on every render does not restart anything.
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
  /**
   * The last successful value, or null before the first one lands. Resets to
   * null when `queryKey` changes, so a stale page is never shown under a new
   * key.
   */
  data: T | null;
  /** The last failure, or null. Cleared by the next success. */
  error: unknown;
  /**
   * True until the first fetch settles, and true again from a `queryKey`
   * change until the first fetch for the new key settles. Gate a skeleton on
   * this.
   */
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
   * than starting a second, unless that one is past its deadline, in which case
   * it is aborted and a new attempt starts.
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
 * `maxBackoffMs`, never below the interval, and a success resets it. `data` is
 * left alone by a failure, so a panel keeps showing the last good value with
 * the error beside it.
 *
 * Nothing can stall the loop for good. Each attempt, from the token wait to the
 * last byte of the body, runs under `attemptTimeoutMs`; one that outlives it is
 * aborted and counted as a failure, and the next poll starts afresh. A watchdog
 * restarts polling when no attempt has started or settled within
 * `stallTimeoutMs` while the document is visible, and checks the moment the
 * document returns to visible.
 *
 * `queryKey` identifies the query, not just the invalidation channel. Changing
 * it starts a fresh query: the timer and any backoff reset, a fetch goes out
 * immediately, and the refetch subscription moves to the new key. A result
 * still in flight for the previous key is dropped rather than landing under the
 * new one. Keys are compared by a stable serialisation, so an array assembled
 * inline on every render, `['jobs', page, status]`, restarts nothing while its
 * segments hold. A caller whose key never changes sees the behaviour it always
 * had.
 *
 * On a key change `data` resets to null and `isLoading` reads true again,
 * unlike a failed poll, which keeps the last value. The old key's rows are a
 * different question's answer, so showing page one's list under a page two
 * heading would be wrong rather than merely stale; a caller that prefers to
 * hold the previous page keeps its own copy of `data` across the change.
 *
 * @example
 * ```ts
 * const { data, isStale, refetch } = usePolledQuery(
 *   ({ signal }) =>
 *     client
 *       .get<Job[]>('/jobs/', { query: { page }, signal })
 *       .then((r) => r.data),
 *   { intervalMs: 10_000, queryKey: ['jobs', page], auth }
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
    attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
    queryKey,
    auth,
  } = options;
  const stallTimeoutMs =
    options.stallTimeoutMs ??
    Math.max(intervalMs, maxBackoffMs) +
      (attemptTimeoutMs > 0 ? attemptTimeoutMs : DEFAULT_ATTEMPT_TIMEOUT_MS);

  const serializedKey = useMemo(
    () => (queryKey === undefined ? undefined : serializeQueryKey(queryKey)),
    [queryKey]
  );

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [isLoading, setIsLoading] = useState(enabled);
  const [isFetching, setIsFetching] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [staleAt, setStaleAt] = useState<number | null>(null);

  const live = useRef(true);
  const generation = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const authRef = useRef(auth);
  authRef.current = auth;

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  const inFlight = useRef<Promise<void> | undefined>(undefined);
  const deadlineAt = useRef<number | undefined>(undefined);
  const lastProgressAt = useRef(0);
  const failures = useRef(0);
  const waited = useRef(false);

  const clearTimer = useCallback((): void => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, []);

  /**
   * Lets go of the attempt in flight: forgets it first, so it knows it has
   * been superseded, then aborts it.
   */
  const release = useCallback((): void => {
    const current = controller.current;
    controller.current = undefined;
    inFlight.current = undefined;
    deadlineAt.current = undefined;
    current?.abort();
  }, []);

  /**
   * The wait before the next poll: the interval when the last fetch succeeded,
   * and an exponential backoff with full jitter once it has not, capped at
   * `maxBackoffMs` and never shorter than the interval.
   */
  const nextDelay = useCallback((): number => {
    if (failures.current === 0) {
      return intervalMs;
    }
    const ceiling = Math.min(intervalMs * 2 ** failures.current, maxBackoffMs);
    return Math.max(
      intervalMs,
      ceiling * (1 - BACKOFF_JITTER + Math.random() * BACKOFF_JITTER)
    );
  }, [intervalMs, maxBackoffMs]);

  /** Everything the run loop needs, read through a ref to keep `run` stable. */
  const settings = useRef({
    enabled,
    intervalMs,
    staleTimeMs,
    refetchOnVisible,
    attemptTimeoutMs,
  });
  settings.current = {
    enabled,
    intervalMs,
    staleTimeMs,
    refetchOnVisible,
    attemptTimeoutMs,
  };

  const schedule = useRef<() => void>(() => undefined);

  /**
   * One attempt. De-duplication is the `inFlight` promise: a concurrent caller
   * is handed the running one, so a focus event landing on top of an interval
   * tick does not double the request. An attempt past its deadline is never
   * handed out; it is released and a new one starts, which also covers a
   * background tab whose deadline timer was throttled.
   *
   * The deadline races the whole attempt, token wait and fetcher alike, so a
   * hung token refresh or body read cannot hold the loop even when the fetcher
   * ignores its signal.
   */
  const run = useCallback((): Promise<void> => {
    if (inFlight.current !== undefined) {
      if (deadlineAt.current === undefined || Date.now() < deadlineAt.current) {
        return inFlight.current;
      }
      release();
    }
    const abort = new AbortController();
    controller.current = abort;
    const generationAtStart = generation.current;
    const timeoutMs = settings.current.attemptTimeoutMs;
    const startedAt = Date.now();
    deadlineAt.current = timeoutMs > 0 ? startedAt + timeoutMs : undefined;
    lastProgressAt.current = startedAt;
    setIsFetching(true);

    const superseded = (): boolean =>
      !live.current ||
      controller.current !== abort ||
      generation.current !== generationAtStart;

    const work = async (): Promise<T> => {
      const waitForToken = authRef.current?.waitForToken;
      if (waitForToken !== undefined && !waited.current) {
        waited.current = true;
        await waitForToken.call(authRef.current);
      }
      abort.signal.throwIfAborted();
      return fetcherRef.current({ signal: abort.signal });
    };

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let stopListening = (): void => undefined;
    const cutoff = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(deadlineTimer);
        reject(
          abort.signal.reason instanceof Error
            ? abort.signal.reason
            : new Error('Poll attempt aborted.')
        );
      };
      abort.signal.addEventListener('abort', onAbort, { once: true });
      stopListening = () => {
        abort.signal.removeEventListener('abort', onAbort);
      };
      if (timeoutMs > 0) {
        deadlineTimer = setTimeout(() => {
          abort.abort(new PolledQueryTimeoutError(timeoutMs));
        }, timeoutMs);
      }
    });
    const pending = work();
    pending.catch(() => undefined);
    cutoff.catch(() => undefined);

    const attempt = (async (): Promise<void> => {
      let owned = false;
      try {
        const value = await Promise.race([pending, cutoff]);
        if (superseded()) {
          return;
        }
        failures.current = 0;
        const now = Date.now();
        setData(value);
        setError(null);
        setLastUpdatedAt(now);
        setStaleAt(now + settings.current.staleTimeMs);
      } catch (thrown) {
        if (superseded()) {
          return;
        }
        failures.current += 1;
        setError(thrown);
      } finally {
        owned = !superseded();
        clearTimeout(deadlineTimer);
        stopListening();
        if (owned) {
          controller.current = undefined;
          inFlight.current = undefined;
          deadlineAt.current = undefined;
          lastProgressAt.current = Date.now();
          setIsFetching(false);
          setIsLoading(false);
        }
      }
      if (owned && settings.current.enabled) {
        schedule.current();
      }
    })();

    inFlight.current = attempt;
    return attempt;
  }, [release]);

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

  /**
   * Starts polling over: drops the timer and whatever is in flight and fetches
   * now, keeping the backoff count so a failing query stays backed off.
   */
  const restart = useCallback((): void => {
    clearTimer();
    release();
    void run();
  }, [clearTimer, release, run]);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      clearTimer();
      release();
    };
  }, [clearTimer, release]);

  const activeKey = useRef(serializedKey);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (activeKey.current === serializedKey) {
      return;
    }
    activeKey.current = serializedKey;
    generation.current += 1;
    clearTimer();
    release();
    failures.current = 0;
    waited.current = false;
    setData(null);
    setError(null);
    setLastUpdatedAt(null);
    setStaleAt(null);
    setIsFetching(false);
    setIsLoading(enabledRef.current);
  }, [serializedKey, clearTimer, release]);

  useEffect(() => {
    if (!enabled) {
      clearTimer();
      release();
      failures.current = 0;
      setIsFetching(false);
      return;
    }
    void run();
    return clearTimer;
  }, [enabled, intervalMs, serializedKey, clearTimer, release, run]);

  useEffect(() => {
    if (!enabled || serializedKey === undefined) {
      return;
    }
    return subscribeToRefetch(serializedKey, () => {
      void refetch();
    });
  }, [enabled, serializedKey, refetch]);

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

  useEffect(() => {
    if (!enabled || stallTimeoutMs <= 0) {
      return;
    }
    const check = (): void => {
      if (!documentVisible()) {
        return;
      }
      if (Date.now() - lastProgressAt.current > stallTimeoutMs) {
        restart();
      }
    };
    const watchdog = setInterval(check, Math.max(1, stallTimeoutMs / 4));
    const hasDocument = typeof document !== 'undefined';
    if (hasDocument) {
      document.addEventListener('visibilitychange', check);
    }
    return () => {
      clearInterval(watchdog);
      if (hasDocument) {
        document.removeEventListener('visibilitychange', check);
      }
    };
  }, [enabled, stallTimeoutMs, restart]);

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
 * `keys` is read when `mutate` runs rather than when the hook renders, so a key
 * built from current props or state invalidates what the component is showing
 * now. An array of primitives is one array key; pass several keys as an array
 * holding at least one array key, `[['jobs', page], 'counts']`.
 *
 * @example
 * ```ts
 * const { mutate, isMutating } = useMutationWithRefetch(
 *   (name: string) => client.post('/jobs/', { name }),
 *   ['jobs', page]
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
  serializeQueryKey,
  subscribeToRefetch,
  type QueryKey,
  type QueryKeyPart,
  type Unsubscribe,
} from './refetch-registry.js';
