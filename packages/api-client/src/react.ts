/**
 * React bindings. A separate entry point so the core package stays framework
 * free and an application that only needs the client never pulls React into
 * its bundle.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { idleForMs, subscribeToActivity } from './activity.js';
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
 * Milliseconds without pointer, key, wheel, touch or focus activity after which
 * polling starts to stretch, when `idleAfterMs` is not given.
 */
export const DEFAULT_IDLE_AFTER_MS = 120_000;

/** Ceiling on the idle stretched interval when `maxIdleIntervalMs` is not given. */
export const DEFAULT_MAX_IDLE_INTERVAL_MS = 300_000;

/** Growth per idle poll when `idleBackoffMultiplier` is not given. */
export const DEFAULT_IDLE_BACKOFF_MULTIPLIER = 2;

/** Header carrying the validator of the data already held. */
export const IF_NONE_MATCH_HEADER = 'if-none-match';

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

/**
 * What a poll attempt rejects with when the fetcher reports a 304 while the
 * hook holds no data to keep. The held ETag is dropped, so the next poll reads
 * in full.
 */
export class PolledQueryNotModifiedError extends Error {
  constructor() {
    super('Received 304 Not Modified with no data held for this query.');
    this.name = 'PolledQueryNotModifiedError';
    Object.setPrototypeOf(this, PolledQueryNotModifiedError.prototype);
  }
}

/** What a fetcher receives. The signal aborts on unmount and on a supersede. */
export interface PolledQueryContext {
  /** Abort signal for the request. Pass it straight to the client. */
  signal: AbortSignal;
  /**
   * The ETag of the data the hook holds for the current key, or undefined when
   * it holds none. Only set once a fetcher has returned a
   * {@link polledResponse} carrying one.
   */
  etag: string | undefined;
  /**
   * Conditional request headers to merge into the request: `If-None-Match`
   * when an ETag is held, empty otherwise. Spread it into the client's
   * `headers` option.
   */
  headers: Readonly<Record<string, string>>;
}

/**
 * The parts of a response {@link polledResponse} reads. The client's
 * `ApiResponse` fits as it is.
 */
export interface ConditionalResponse<T> {
  /** The parsed body. Ignored on a 304. */
  data: T;
  /** The HTTP status. 304 means the held data is still current. */
  status: number;
  /** The response headers. Only `ETag` is read. */
  headers: Pick<Headers, 'get'>;
}

/**
 * A fetcher result that carries the status and ETag alongside the data, which
 * is what turns on conditional polling. Build it with {@link polledResponse}.
 */
export class PolledResponse<T> {
  /** The parsed body, undefined on a 304. */
  readonly data: T | undefined;
  /** The HTTP status. */
  readonly status: number;
  /** The `ETag` response header, weak or strong, or undefined. */
  readonly etag: string | undefined;

  constructor(response: ConditionalResponse<T>) {
    this.status = response.status;
    this.data = response.status === 304 ? undefined : response.data;
    const etag = response.headers.get('etag');
    this.etag = etag === null || etag === '' ? undefined : etag;
  }

  /** Whether the server answered 304 Not Modified. */
  get notModified(): boolean {
    return this.status === 304;
  }
}

/**
 * Wraps a response so {@link usePolledQuery} remembers its ETag and keeps the
 * held data on a 304. Pass it the client's response, having sent the context
 * `headers` with the request:
 *
 * @example
 * ```ts
 * usePolledQuery(({ signal, headers }) =>
 *   client.get<Job[]>('/jobs/', { signal, headers }).then(polledResponse)
 * );
 * ```
 */
export function polledResponse<T>(
  response: ConditionalResponse<T>
): PolledResponse<T> {
  return new PolledResponse(response);
}

/**
 * Reads the data. Receives a signal and should honour it. Resolves to the value
 * itself, or to a {@link polledResponse} for conditional polling.
 */
export type PolledQueryFetcher<T> = (
  context: PolledQueryContext
) => Promise<T | PolledResponse<T>>;

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
   * Milliseconds between polls while the document is hidden, in place of
   * pausing. Only read while `refetchOnVisible` is true, and never faster than
   * the interval the query would otherwise use. Defaults to 0, which pauses.
   */
  hiddenIntervalMs?: number;
  /**
   * Milliseconds without pointer, key, wheel, touch or focus activity on the
   * page after which the interval starts to stretch by `idleBackoffMultiplier`
   * per poll, up to `maxIdleIntervalMs`. The first activity afterwards refetches
   * once and returns to `intervalMs`. Defaults to
   * {@link DEFAULT_IDLE_AFTER_MS}. 0 disables idle backoff.
   */
  idleAfterMs?: number;
  /**
   * Factor the interval grows by on each poll taken while idle. Defaults to
   * {@link DEFAULT_IDLE_BACKOFF_MULTIPLIER}.
   */
  idleBackoffMultiplier?: number;
  /**
   * Ceiling on the idle stretched interval. Never below `intervalMs`. Defaults
   * to {@link DEFAULT_MAX_IDLE_INTERVAL_MS}.
   */
  maxIdleIntervalMs?: number;
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
   * when the poll loop has stalled. A wait scheduled longer than
   * `max(intervalMs, maxBackoffMs)`, such as an idle stretched one, extends it
   * by the excess. 0 disables it.
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
   * True while the query is enabled and no fetch for the current `queryKey` has
   * settled yet, so only before the first data or error arrives. Background
   * polls, hidden-tab polls and refetches never set it. A query enabled late
   * reads true from the render that enables it, a disabled query reads false,
   * and a `queryKey` change reads true again until the new key's first fetch
   * settles. Gate a skeleton on this.
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
 * Idle tabs poll less. While the document is hidden polling pauses, or runs no
 * faster than `hiddenIntervalMs` when that is set. Once the page has seen no
 * pointer, key, wheel, touch or focus activity for `idleAfterMs`, each poll
 * stretches the interval by `idleBackoffMultiplier` up to `maxIdleIntervalMs`,
 * and the first activity afterwards refetches once and returns to `intervalMs`.
 *
 * Polling can be conditional. A fetcher that sends the context `headers` and
 * resolves to {@link polledResponse} has its ETag remembered for the current
 * key and sent back as `If-None-Match`. A 304 keeps the held `data`, with its
 * identity, and writes no data or error state, so consumers memoised on `data`
 * do no work. A fetcher that resolves to the value itself polls as before.
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
    hiddenIntervalMs = 0,
    idleAfterMs = DEFAULT_IDLE_AFTER_MS,
    idleBackoffMultiplier = DEFAULT_IDLE_BACKOFF_MULTIPLIER,
    maxIdleIntervalMs = DEFAULT_MAX_IDLE_INTERVAL_MS,
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
  const [settled, setSettled] = useState(false);
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
  const validator = useRef<string | undefined>(undefined);
  const idlePolls = useRef(0);
  const scheduledDelay = useRef(0);

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
  const currentSettings = {
    enabled,
    intervalMs,
    staleTimeMs,
    refetchOnVisible,
    attemptTimeoutMs,
    hiddenIntervalMs,
    idleAfterMs,
    idleBackoffMultiplier,
    maxIdleIntervalMs,
  };
  const settings = useRef(currentSettings);
  settings.current = currentSettings;

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
    const etag = validator.current;
    const headers: Readonly<Record<string, string>> =
      etag === undefined ? {} : { [IF_NONE_MATCH_HEADER]: etag };
    const startedAt = Date.now();
    deadlineAt.current = timeoutMs > 0 ? startedAt + timeoutMs : undefined;
    lastProgressAt.current = startedAt;
    setIsFetching(true);

    const superseded = (): boolean =>
      !live.current ||
      controller.current !== abort ||
      generation.current !== generationAtStart;

    const work = async (): Promise<T | PolledResponse<T>> => {
      const waitForToken = authRef.current?.waitForToken;
      if (waitForToken !== undefined && !waited.current) {
        waited.current = true;
        await waitForToken.call(authRef.current);
      }
      abort.signal.throwIfAborted();
      return fetcherRef.current({ signal: abort.signal, etag, headers });
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
        if (value instanceof PolledResponse) {
          if (value.notModified && etag === undefined) {
            validator.current = undefined;
            throw new PolledQueryNotModifiedError();
          }
          validator.current =
            value.etag ?? (value.notModified ? etag : undefined);
          if (!value.notModified) {
            setData(value.data as T);
          }
        } else {
          validator.current = undefined;
          setData(value);
        }
        failures.current = 0;
        const now = Date.now();
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
          setSettled(true);
        }
      }
      if (owned && settings.current.enabled) {
        schedule.current();
      }
    })();

    inFlight.current = attempt;
    return attempt;
  }, [release]);

  /**
   * The wait before the next poll: the error backoff, stretched while the page
   * is idle and slowed to `hiddenIntervalMs` while the document is hidden.
   * Counts the idle polls, which is what the stretch grows with.
   */
  const pollDelay = useCallback(
    (hidden: boolean): number => {
      const current = settings.current;
      let delay = nextDelay();
      if (current.idleAfterMs > 0 && idleForMs() >= current.idleAfterMs) {
        idlePolls.current += 1;
        const growth = Math.max(1, current.idleBackoffMultiplier);
        const ceiling = Math.max(current.intervalMs, current.maxIdleIntervalMs);
        delay = Math.max(
          delay,
          Math.min(current.intervalMs * growth ** idlePolls.current, ceiling)
        );
      } else {
        idlePolls.current = 0;
      }
      if (hidden) {
        delay = Math.max(delay, current.hiddenIntervalMs);
      }
      return delay;
    },
    [nextDelay]
  );

  schedule.current = useCallback((): void => {
    clearTimer();
    const current = settings.current;
    if (!current.enabled) {
      return;
    }
    const hidden = current.refetchOnVisible && !documentVisible();
    if (hidden && current.hiddenIntervalMs <= 0) {
      return;
    }
    const delay = pollDelay(hidden);
    scheduledDelay.current = delay;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      if (live.current && settings.current.enabled) {
        void run();
      }
    }, delay);
  }, [clearTimer, pollDelay, run]);

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
    validator.current = undefined;
    idlePolls.current = 0;
    setData(null);
    setError(null);
    setLastUpdatedAt(null);
    setStaleAt(null);
    setIsFetching(false);
    setSettled(false);
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
      } else if (
        settings.current.hiddenIntervalMs > 0 &&
        inFlight.current === undefined
      ) {
        schedule.current();
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
    if (!enabled || idleAfterMs <= 0) {
      return;
    }
    return subscribeToActivity(() => {
      if (idlePolls.current === 0) {
        return;
      }
      idlePolls.current = 0;
      if (settings.current.refetchOnVisible && !documentVisible()) {
        return;
      }
      clearTimer();
      void run();
    });
  }, [enabled, idleAfterMs, clearTimer, run]);

  useEffect(() => {
    if (!enabled || stallTimeoutMs <= 0) {
      return;
    }
    const healthyGap = Math.max(intervalMs, maxBackoffMs);
    const check = (): void => {
      if (!documentVisible()) {
        return;
      }
      const threshold =
        stallTimeoutMs + Math.max(0, scheduledDelay.current - healthyGap);
      if (Date.now() - lastProgressAt.current > threshold) {
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
  }, [enabled, stallTimeoutMs, intervalMs, maxBackoffMs, restart]);

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
  const isLoading = enabled && !settled;

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
  /**
   * Returns the hook to its idle state: `error` null and `isMutating` false. A
   * write already in flight still settles its own promise and still
   * invalidates on success, but no longer writes to the hook's state.
   */
  reset: () => void;
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
  const generation = useRef(0);
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
    const started = generation.current;
    const current = (): boolean =>
      live.current && generation.current === started;
    setIsMutating(true);
    setError(null);
    try {
      const result = await writeRef.current(...args);
      invalidateQueries(keysRef.current);
      return result;
    } catch (thrown) {
      if (current()) {
        setError(thrown);
      }
      throw thrown;
    } finally {
      if (current()) {
        setIsMutating(false);
      }
    }
  }, []);

  const reset = useCallback((): void => {
    generation.current += 1;
    setError(null);
    setIsMutating(false);
  }, []);

  return useMemo(
    () => ({ mutate, isMutating, error, reset }),
    [mutate, isMutating, error, reset]
  );
}

export { idleForMs, subscribeToActivity } from './activity.js';
export {
  invalidateQueries,
  serializeQueryKey,
  subscribeToRefetch,
  type QueryKey,
  type QueryKeyPart,
  type Unsubscribe,
} from './refetch-registry.js';
