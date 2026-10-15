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
  observeInvalidations,
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

/**
 * Milliseconds a cache entry survives once no mounted query holds it, when
 * `cacheTimeMs` is not given.
 */
export const DEFAULT_CACHE_TIME_MS = 300_000;

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
  /**
   * Milliseconds the shared cache keeps this key's entry once no mounted query
   * holds it. Defaults to {@link DEFAULT_CACHE_TIME_MS}. Only keyed queries are
   * cached.
   */
  cacheTimeMs?: number;
}

/** Options for {@link prefetchPolledQuery}. */
export interface PrefetchPolledQueryOptions {
  /**
   * Age below which a cached entry is fresh enough to skip the read. Defaults
   * to {@link DEFAULT_POLL_INTERVAL_MS}.
   */
  staleTimeMs?: number;
  /**
   * Deadline on the read. Defaults to {@link DEFAULT_ATTEMPT_TIMEOUT_MS}. 0
   * disables it.
   */
  attemptTimeoutMs?: number;
  /**
   * How long the entry survives with no mounted query holding it. Defaults to
   * {@link DEFAULT_CACHE_TIME_MS}.
   */
  cacheTimeMs?: number;
}

/** What {@link usePolledQuery} returns. */
export interface PolledQueryResult<T> {
  /**
   * The last successful value, or null before the first one lands. A keyed
   * query starts from the shared cache when it holds the key, and otherwise
   * resets to null when `queryKey` changes, so a stale page is never shown
   * under a new key.
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
   * it is aborted and a new attempt starts. A read another query on the same key
   * has in flight is joined the same way. Otherwise the key's cache entry is
   * marked for a read, so a later mount does not paint it as fresh.
   */
  refetch: () => Promise<void>;
}

/** Fractional jitter applied to a backoff delay, as a proportion of it. */
const BACKOFF_JITTER = 0.5;

/** What one shared read settled with. */
type RequestOutcome =
  | { ok: true; notModified: boolean; data: unknown; fetchedAt: number }
  | { ok: false; error: unknown };

/** One network read, shared by every query on the key that joins it. */
interface SharedRequest {
  readonly promise: Promise<RequestOutcome>;
  readonly controller: AbortController;
  readonly deadlineAt: number | undefined;
  waiters: number;
  settled: boolean;
}

/** Hears every outcome a cache entry's reads settle with. */
type EntryListener = (outcome: RequestOutcome, request: SharedRequest) => void;

/**
 * What the cache holds for one key: the data, its ETag, when it was read, and
 * the read in flight. A query with no key gets a private entry of its own.
 */
interface CacheEntry {
  readonly key: string | undefined;
  data: unknown;
  hasData: boolean;
  etag: string | undefined;
  fetchedAt: number | null;
  invalidated: boolean;
  version: number;
  generation: number;
  request: SharedRequest | undefined;
  readonly listeners: Set<EntryListener>;
  holders: number;
  evictTimer: ReturnType<typeof setTimeout> | undefined;
}

const cache = new Map<string, CacheEntry>();

let stopObserving: (() => void) | undefined;

/** Builds an empty entry. */
function createEntry(key: string | undefined): CacheEntry {
  return {
    key,
    data: undefined,
    hasData: false,
    etag: undefined,
    fetchedAt: null,
    invalidated: false,
    version: 0,
    generation: 0,
    request: undefined,
    listeners: new Set(),
    holders: 0,
    evictTimer: undefined,
  };
}

/** Marks an entry as needing a read whatever its age. */
function markInvalidated(entry: CacheEntry): void {
  entry.invalidated = true;
  entry.version += 1;
}

/** Starts marking cached entries on {@link invalidateQueries}, once. */
function observeOnce(): void {
  stopObserving ??= observeInvalidations((key) => {
    const entry = cache.get(key);
    if (entry !== undefined) {
      markInvalidated(entry);
    }
  });
}

/** Cancels a pending eviction. */
function clearEviction(entry: CacheEntry): void {
  if (entry.evictTimer !== undefined) {
    clearTimeout(entry.evictTimer);
    entry.evictTimer = undefined;
  }
}

/** Takes a hold on the key's entry, creating it when absent. */
function acquireEntry(key: string): CacheEntry {
  observeOnce();
  let entry = cache.get(key);
  if (entry === undefined) {
    entry = createEntry(key);
    cache.set(key, entry);
  }
  entry.holders += 1;
  clearEviction(entry);
  return entry;
}

/** Drops a hold, scheduling eviction once nothing holds the entry. */
function releaseEntry(entry: CacheEntry, cacheTimeMs: number): void {
  entry.holders = Math.max(0, entry.holders - 1);
  if (entry.holders === 0) {
    scheduleEviction(entry, cacheTimeMs);
  }
}

/** Evicts an unheld entry after `cacheTimeMs`, waiting out a read in flight. */
function scheduleEviction(entry: CacheEntry, cacheTimeMs: number): void {
  clearEviction(entry);
  const key = entry.key;
  if (key === undefined || !Number.isFinite(cacheTimeMs)) {
    return;
  }
  entry.evictTimer = setTimeout(
    () => {
      entry.evictTimer = undefined;
      if (entry.holders > 0 || cache.get(key) !== entry) {
        return;
      }
      if (entry.request !== undefined) {
        scheduleEviction(entry, cacheTimeMs);
        return;
      }
      cache.delete(key);
    },
    Math.max(0, cacheTimeMs)
  );
}

/** Whether the entry holds data read within `staleTimeMs` and not invalidated. */
function isFresh(entry: CacheEntry, staleTimeMs: number, now: number): boolean {
  return (
    entry.hasData &&
    !entry.invalidated &&
    entry.fetchedAt !== null &&
    now - entry.fetchedAt < staleTimeMs
  );
}

/** The error an aborted signal rejects with. */
function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Poll attempt aborted.');
}

/** Tells every listener of the entry how a read settled. */
function notify(
  entry: CacheEntry,
  outcome: RequestOutcome,
  request: SharedRequest
): void {
  for (const listener of [...entry.listeners]) {
    listener(outcome, request);
  }
}

/**
 * Joins the entry's read in flight, or starts one with `fetcher` and the held
 * ETag. A read past its deadline is never joined: it is left to the queries
 * already waiting on it and a new one starts.
 */
function joinRequest(
  entry: CacheEntry,
  fetcher: PolledQueryFetcher<unknown>,
  timeoutMs: number
): SharedRequest {
  const now = Date.now();
  const running = entry.request;
  if (
    running !== undefined &&
    (running.deadlineAt === undefined || now < running.deadlineAt)
  ) {
    running.waiters += 1;
    return running;
  }
  const controller = new AbortController();
  const etag = entry.etag;
  const headers: Readonly<Record<string, string>> =
    etag === undefined ? {} : { [IF_NONE_MATCH_HEADER]: etag };
  const generation = entry.generation;
  const version = entry.version;
  const aborted = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener(
      'abort',
      () => {
        reject(abortError(controller.signal));
      },
      { once: true }
    );
  });
  aborted.catch(() => undefined);
  const read = (async (): Promise<unknown> =>
    fetcher({ signal: controller.signal, etag, headers }))();
  const request: SharedRequest = {
    controller,
    deadlineAt: timeoutMs > 0 ? now + timeoutMs : undefined,
    waiters: 1,
    settled: false,
    promise: Promise.race([read, aborted]).then(
      (value) =>
        settleRequest(entry, request, generation, version, etag, value),
      (thrown: unknown) => failRequest(entry, request, generation, thrown)
    ),
  };
  entry.request = request;
  return request;
}

/**
 * Writes a read's value into the entry, unless the cache was cleared while it
 * ran, and tells the entry's listeners.
 */
function settleRequest(
  entry: CacheEntry,
  request: SharedRequest,
  generation: number,
  version: number,
  sentEtag: string | undefined,
  value: unknown
): RequestOutcome {
  request.settled = true;
  if (entry.request === request) {
    entry.request = undefined;
  }
  const current = entry.generation === generation;
  const fetchedAt = Date.now();
  let outcome: RequestOutcome;
  if (value instanceof PolledResponse) {
    if (value.notModified && sentEtag === undefined) {
      if (current) {
        entry.etag = undefined;
      }
      outcome = { ok: false, error: new PolledQueryNotModifiedError() };
    } else if (value.notModified) {
      if (current) {
        entry.etag = value.etag ?? sentEtag;
      }
      outcome = {
        ok: true,
        notModified: true,
        data: current ? entry.data : undefined,
        fetchedAt,
      };
    } else {
      if (current) {
        entry.etag = value.etag;
        entry.data = value.data;
        entry.hasData = true;
      }
      outcome = { ok: true, notModified: false, data: value.data, fetchedAt };
    }
  } else {
    if (current) {
      entry.etag = undefined;
      entry.data = value;
      entry.hasData = true;
    }
    outcome = { ok: true, notModified: false, data: value, fetchedAt };
  }
  if (current) {
    if (outcome.ok) {
      entry.fetchedAt = fetchedAt;
      if (entry.version === version) {
        entry.invalidated = false;
      }
    }
    notify(entry, outcome, request);
  }
  return outcome;
}

/** Settles a failed read, telling the listeners unless it was abandoned. */
function failRequest(
  entry: CacheEntry,
  request: SharedRequest,
  generation: number,
  thrown: unknown
): RequestOutcome {
  request.settled = true;
  if (entry.request === request) {
    entry.request = undefined;
  }
  const outcome: RequestOutcome = { ok: false, error: thrown };
  if (!request.controller.signal.aborted && entry.generation === generation) {
    notify(entry, outcome, request);
  }
  return outcome;
}

/** Stops waiting on a read, aborting it once nothing waits on it. */
function leaveRequest(
  entry: CacheEntry,
  request: SharedRequest,
  reason: unknown
): void {
  if (request.settled) {
    return;
  }
  request.waiters -= 1;
  if (request.waiters > 0) {
    return;
  }
  if (entry.request === request) {
    entry.request = undefined;
  }
  request.controller.abort(reason);
}

/**
 * Empties the shared {@link usePolledQuery} cache: every key's data and ETag
 * are dropped and reads in flight no longer write into it. Call it on sign-out
 * and on any switch that changes what an unscoped key means, such as a
 * workspace switch. Mounted queries keep what they show and read afresh on
 * their next poll; invalidate their keys to read now.
 */
export function clearPolledQueryCache(): void {
  for (const [key, entry] of cache) {
    entry.generation += 1;
    entry.version += 1;
    entry.data = undefined;
    entry.hasData = false;
    entry.etag = undefined;
    entry.fetchedAt = null;
    entry.invalidated = false;
    entry.request = undefined;
    if (entry.holders === 0) {
      clearEviction(entry);
      cache.delete(key);
    }
  }
}

/**
 * Warms the shared cache for `key`, for example on hover, so a query mounted
 * on it afterwards paints at once. Skips the read when the entry is fresher
 * than `staleTimeMs`, and joins a read already in flight. Resolves once the
 * read settles or times out, and never rejects: a failed prefetch leaves the
 * query to read for itself.
 *
 * @example
 * ```ts
 * onMouseEnter={() =>
 *   void prefetchPolledQuery(['issue', id], ({ signal, headers }) =>
 *     client.get<Issue>(`/issues/${id}`, { signal, headers }).then(polledResponse)
 *   )
 * }
 * ```
 */
export function prefetchPolledQuery<T>(
  key: QueryKey,
  fetcher: PolledQueryFetcher<T>,
  options: PrefetchPolledQueryOptions = {}
): Promise<void> {
  const {
    staleTimeMs = DEFAULT_POLL_INTERVAL_MS,
    attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
    cacheTimeMs = DEFAULT_CACHE_TIME_MS,
  } = options;
  const entry = acquireEntry(serializeQueryKey(key));
  if (isFresh(entry, staleTimeMs, Date.now())) {
    releaseEntry(entry, cacheTimeMs);
    return Promise.resolve();
  }
  const request = joinRequest(entry, fetcher, attemptTimeoutMs);
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    if (attemptTimeoutMs > 0) {
      deadlineTimer = setTimeout(() => {
        leaveRequest(
          entry,
          request,
          new PolledQueryTimeoutError(attemptTimeoutMs)
        );
        resolve();
      }, attemptTimeoutMs);
    }
  });
  return Promise.race([request.promise.then(() => undefined), deadline]).then(
    () => {
      clearTimeout(deadlineTimer);
      releaseEntry(entry, cacheTimeMs);
    }
  );
}

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
 * Dependency free: no react-query. Keyed queries share a module scoped
 * stale-while-revalidate cache, so a remount or a second component on the same
 * key paints from what was last read instead of starting empty.
 *
 * The cache holds, per serialised `queryKey`, the data, its ETag and when it
 * was read. A query mounting on a key the cache holds, or changing to one,
 * takes the data at once with `isLoading` false, and reads again only when the
 * entry is older than `staleTimeMs` or was invalidated. Queries sharing a key
 * share one read: whichever polls first starts it, the others join it, and
 * every one of them takes the result and restarts its timer from it, so the
 * key is polled once per interval of its fastest subscriber. The held ETag goes
 * out as `If-None-Match`, so a remount revalidates with a 304. `refetch` and
 * {@link invalidateQueries} mark the entry for a read, {@link prefetchPolledQuery}
 * warms it, {@link clearPolledQueryCache} empties it, and an entry no mounted
 * query has held for `cacheTimeMs` is evicted. A query with no key keeps a
 * private entry and behaves exactly as before.
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
 * immediately unless the cache holds the new key fresh, and the refetch
 * subscription moves to the new key. A result still in flight for the previous
 * key is dropped rather than landing under the new one. Keys are compared by a
 * stable serialisation, so an array assembled inline on every render,
 * `['jobs', page, status]`, restarts nothing while its segments hold.
 *
 * On a change to a key the cache does not hold, `data` resets to null and
 * `isLoading` reads true again, unlike a failed poll, which keeps the last
 * value. The old key's rows are a different question's answer, so showing page
 * one's list under a page two heading would be wrong rather than merely stale.
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
    cacheTimeMs = DEFAULT_CACHE_TIME_MS,
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

  const [initial] = useState(() => {
    const entry =
      serializedKey === undefined ? undefined : cache.get(serializedKey);
    if (entry === undefined || !entry.hasData || entry.fetchedAt === null) {
      return undefined;
    }
    return {
      data: entry.data as T,
      fetchedAt: entry.fetchedAt,
      staleAt: entry.invalidated
        ? entry.fetchedAt
        : entry.fetchedAt + staleTimeMs,
    };
  });

  const [data, setData] = useState<T | null>(
    initial === undefined ? null : initial.data
  );
  const [error, setError] = useState<unknown>(null);
  const [settled, setSettled] = useState(initial !== undefined);
  const [isFetching, setIsFetching] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(
    initial === undefined ? null : initial.fetchedAt
  );
  const [staleAt, setStaleAt] = useState<number | null>(
    initial === undefined ? null : initial.staleAt
  );

  const live = useRef(true);
  const generation = useRef(0);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const authRef = useRef(auth);
  authRef.current = auth;
  const dataRef = useRef<T | null>(data);

  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const controller = useRef<AbortController | undefined>(undefined);
  const inFlight = useRef<Promise<void> | undefined>(undefined);
  const joined = useRef<SharedRequest | undefined>(undefined);
  const entryRef = useRef<CacheEntry | undefined>(undefined);
  const privateEntry = useRef<CacheEntry | undefined>(undefined);
  const deadlineAt = useRef<number | undefined>(undefined);
  const lastProgressAt = useRef(0);
  const failures = useRef(0);
  const waited = useRef(false);
  const idlePolls = useRef(0);
  const scheduledDelay = useRef(0);

  /** Sets `data`, keeping the ref the 304 path compares against in step. */
  const writeData = useCallback((value: T | null): void => {
    dataRef.current = value;
    setData(value);
  }, []);

  /** The entry this query reads through: the key's, or its private one. */
  const entryFor = useCallback((): CacheEntry => {
    if (entryRef.current !== undefined) {
      return entryRef.current;
    }
    privateEntry.current ??= createEntry(undefined);
    return privateEntry.current;
  }, []);

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
    joined.current = undefined;
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
    cacheTimeMs,
  };
  const settings = useRef(currentSettings);
  settings.current = currentSettings;

  const schedule = useRef<(delayMs?: number) => void>(() => undefined);

  /** Writes a successful read into state; a 304 keeps the held data. */
  const applySuccess = useCallback(
    (outcome: Extract<RequestOutcome, { ok: true }>): void => {
      if (!outcome.notModified) {
        writeData(outcome.data as T);
      } else if (dataRef.current === null && outcome.data !== undefined) {
        writeData(outcome.data as T);
      }
      failures.current = 0;
      setError(null);
      setLastUpdatedAt(outcome.fetchedAt);
      setStaleAt(outcome.fetchedAt + settings.current.staleTimeMs);
    },
    [writeData]
  );

  /**
   * One attempt. De-duplication is the `inFlight` promise: a concurrent caller
   * is handed the running one, so a focus event landing on top of an interval
   * tick does not double the request. Across queries on one key it is the
   * cache entry's shared read, which this attempt joins. An attempt past its
   * deadline is never handed out; it is released and a new one starts, which
   * also covers a background tab whose deadline timer was throttled.
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
    const entry = entryFor();
    const abort = new AbortController();
    controller.current = abort;
    const generationAtStart = generation.current;
    const timeoutMs = settings.current.attemptTimeoutMs;
    const startedAt = Date.now();
    deadlineAt.current = timeoutMs > 0 ? startedAt + timeoutMs : undefined;
    lastProgressAt.current = startedAt;
    setIsFetching(true);
    let shared: SharedRequest | undefined;

    const superseded = (): boolean =>
      !live.current ||
      controller.current !== abort ||
      generation.current !== generationAtStart;

    const work = async (): Promise<RequestOutcome> => {
      const waitForToken = authRef.current?.waitForToken;
      if (waitForToken !== undefined && !waited.current) {
        waited.current = true;
        await waitForToken.call(authRef.current);
      }
      abort.signal.throwIfAborted();
      shared = joinRequest(entry, fetcherRef.current, timeoutMs);
      joined.current = shared;
      return shared.promise;
    };

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let stopListening = (): void => undefined;
    const cutoff = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => {
        clearTimeout(deadlineTimer);
        if (shared !== undefined) {
          leaveRequest(entry, shared, abort.signal.reason);
        }
        reject(abortError(abort.signal));
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
        const outcome = await Promise.race([pending, cutoff]);
        if (superseded()) {
          return;
        }
        if (!outcome.ok) {
          throw outcome.error;
        }
        applySuccess(outcome);
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
          if (joined.current === shared) {
            joined.current = undefined;
          }
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
  }, [applySuccess, entryFor, release]);

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

  schedule.current = useCallback(
    (delayMs?: number): void => {
      clearTimer();
      const current = settings.current;
      if (!current.enabled) {
        return;
      }
      const hidden = current.refetchOnVisible && !documentVisible();
      if (hidden && current.hiddenIntervalMs <= 0) {
        return;
      }
      const delay =
        delayMs === undefined
          ? pollDelay(hidden)
          : Math.max(delayMs, hidden ? current.hiddenIntervalMs : 0);
      scheduledDelay.current = delay;
      timer.current = setTimeout(() => {
        timer.current = undefined;
        if (live.current && settings.current.enabled) {
          void run();
        }
      }, delay);
    },
    [clearTimer, pollDelay, run]
  );

  const refetch = useCallback((): Promise<void> => {
    const entry = entryRef.current;
    if (entry !== undefined && entry.request === undefined) {
      markInvalidated(entry);
    }
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
    const entry =
      serializedKey === undefined ? undefined : acquireEntry(serializedKey);
    entryRef.current = entry;
    const target = entry ?? entryFor();
    const listener: EntryListener = (outcome, request) => {
      if (!live.current || joined.current === request) {
        return;
      }
      if (outcome.ok) {
        applySuccess(outcome);
      } else {
        if (settings.current.enabled) {
          failures.current += 1;
        }
        setError(outcome.error);
      }
      setSettled(true);
      lastProgressAt.current = Date.now();
      if (inFlight.current === undefined && settings.current.enabled) {
        schedule.current();
      }
    };
    target.listeners.add(listener);
    return () => {
      target.listeners.delete(listener);
      if (entryRef.current === entry) {
        entryRef.current = undefined;
      }
      if (entry !== undefined) {
        releaseEntry(entry, settings.current.cacheTimeMs);
      }
    };
  }, [serializedKey, applySuccess, entryFor]);

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
    idlePolls.current = 0;
    setError(null);
    setIsFetching(false);
    const entry = entryRef.current;
    if (entry?.hasData === true && entry.fetchedAt !== null) {
      writeData(entry.data as T);
      setLastUpdatedAt(entry.fetchedAt);
      setStaleAt(
        entry.invalidated
          ? entry.fetchedAt
          : entry.fetchedAt + settings.current.staleTimeMs
      );
      setSettled(true);
      return;
    }
    writeData(null);
    setLastUpdatedAt(null);
    setStaleAt(null);
    setSettled(false);
  }, [serializedKey, clearTimer, release, writeData]);

  useEffect(() => {
    if (!enabled) {
      clearTimer();
      release();
      failures.current = 0;
      setIsFetching(false);
      return;
    }
    const entry = entryRef.current;
    const now = Date.now();
    if (
      entry !== undefined &&
      entry.fetchedAt !== null &&
      isFresh(entry, settings.current.staleTimeMs, now)
    ) {
      if (dataRef.current !== entry.data) {
        writeData(entry.data as T);
      }
      setLastUpdatedAt(entry.fetchedAt);
      setStaleAt(entry.fetchedAt + settings.current.staleTimeMs);
      setSettled(true);
      failures.current = 0;
      lastProgressAt.current = now;
      schedule.current(Math.max(0, entry.fetchedAt + intervalMs - now));
      return clearTimer;
    }
    void run();
    return clearTimer;
  }, [
    enabled,
    intervalMs,
    serializedKey,
    clearTimer,
    release,
    run,
    writeData,
  ]);

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
