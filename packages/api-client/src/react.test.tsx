import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_MAX_BACKOFF_MS,
  invalidateQueries,
  PolledQueryTimeoutError,
  serializeQueryKey,
  useMutationWithRefetch,
  usePolledQuery,
  type PolledQueryOptions,
} from './react.js';

/** A fetcher resolving to successive values, one per call. */
function sequence<T>(values: T[]): ReturnType<typeof vi.fn> {
  let index = 0;
  return vi.fn(() => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return Promise.resolve(value);
  });
}

/** Renders the hook with the timers already faked. */
function render<T>(
  fetcher: (context: { signal: AbortSignal }) => Promise<T>,
  options: PolledQueryOptions = {}
) {
  return renderHook(() => usePolledQuery(fetcher, options));
}

/** Renders the hook with options derived per render from a changeable prop. */
function renderWithProps<T, P>(
  fetcher: (context: { signal: AbortSignal }) => Promise<T>,
  toOptions: (props: P) => PolledQueryOptions,
  initialProps: P
) {
  return renderHook((props: P) => usePolledQuery(fetcher, toOptions(props)), {
    initialProps,
  });
}

/** Advances fake timers and flushes the microtasks each tick releases. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * Flushes the pending microtasks without moving the clock. `waitFor` polls on
 * real timers, which a faked clock never reaches, so the suite settles promise
 * chains explicitly instead.
 */
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) {
      await Promise.resolve();
    }
  });
}

/** Sets `document.visibilityState` and fires the matching event. */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('usePolledQuery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('fetches on mount and exposes the value', async () => {
    const fetcher = sequence(['first']);
    const { result } = render(fetcher, { intervalMs: 1000 });

    await settle();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBe('first');
    expect(result.current.lastUpdatedAt).not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('refetches on each interval tick', async () => {
    const fetcher = sequence(['a', 'b', 'c']);
    const { result } = render(fetcher, { intervalMs: 1000 });

    await settle();
    expect(result.current.data).toBe('a');

    await advance(1000);
    await settle();
    expect(result.current.data).toBe('b');

    await advance(1000);
    await settle();
    expect(result.current.data).toBe('c');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('does not tick while disabled', async () => {
    const fetcher = sequence(['a']);
    render(fetcher, { intervalMs: 1000, enabled: false });

    await advance(5000);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refetches when the window regains focus', async () => {
    const fetcher = sequence(['a', 'b']);
    const { result } = render(fetcher, { intervalMs: 60_000 });

    await settle();
    expect(result.current.data).toBe('a');

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    await settle();
    expect(result.current.data).toBe('b');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not refetch on focus when the option is off', async () => {
    const fetcher = sequence(['a']);
    const { result } = render(fetcher, {
      intervalMs: 60_000,
      refetchOnFocus: false,
    });

    await settle();
    expect(result.current.data).toBe('a');

    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('pauses while hidden and refetches on the way back to visible', async () => {
    const fetcher = sequence(['a', 'b']);
    const { result } = render(fetcher, { intervalMs: 1000 });

    await settle();
    expect(result.current.data).toBe('a');

    await act(async () => {
      setVisibility('hidden');
      await Promise.resolve();
    });
    await advance(5000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      setVisibility('visible');
      await Promise.resolve();
    });
    await settle();
    expect(result.current.data).toBe('b');
  });

  it('backs off after a failure and resets on the next success', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue('recovered');
    vi.spyOn(Math, 'random').mockReturnValue(1);

    const { result } = render(fetcher, {
      intervalMs: 1000,
      maxBackoffMs: 60_000,
    });

    await settle();
    expect(result.current.error).toBeInstanceOf(Error);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await advance(999);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await advance(1001);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);

    await advance(4000);
    await settle();
    expect(result.current.data).toBe('recovered');
    expect(result.current.error).toBeNull();
  });

  it('caps the backoff at maxBackoffMs', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('down'));
    vi.spyOn(Math, 'random').mockReturnValue(1);

    render(fetcher, { intervalMs: 1000, maxBackoffMs: 2000 });

    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    for (let i = 2; i <= 5; i += 1) {
      await advance(2000);
      await settle();
      expect(fetcher).toHaveBeenCalledTimes(i);
    }
  });

  it('keeps the last data when a poll fails', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce('good')
      .mockRejectedValue(new Error('down'));

    const { result } = render(fetcher, { intervalMs: 1000 });

    await settle();
    expect(result.current.data).toBe('good');

    await advance(1000);
    await settle();
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.data).toBe('good');
  });

  it('de-duplicates a refetch against an in-flight fetch', async () => {
    let release: (value: string) => void = () => undefined;
    const fetcher = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        })
    );

    const { result } = render(fetcher, { intervalMs: 60_000 });

    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      void result.current.refetch();
      void result.current.refetch();
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });

    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      release('once');
      await Promise.resolve();
    });

    await settle();
    expect(result.current.data).toBe('once');
  });

  it('aborts the in-flight request on unmount', async () => {
    let captured: AbortSignal | undefined;
    const fetcher = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<string>(() => {
          captured = signal;
        })
    );

    const { unmount } = render(fetcher, { intervalMs: 1000 });

    await settle();
    expect(captured).toBeDefined();
    expect(captured?.aborted).toBe(false);

    unmount();
    expect(captured?.aborted).toBe(true);
  });

  it('reports isStale once staleTimeMs has passed', async () => {
    const fetcher = sequence(['a']);
    const { result } = render(fetcher, {
      intervalMs: 60_000,
      staleTimeMs: 1000,
    });

    await settle();
    expect(result.current.data).toBe('a');
    expect(result.current.isStale).toBe(false);

    await advance(1500);
    await settle();
    expect(result.current.isStale).toBe(true);
  });

  it('waits for the auth token before the first fetch', async () => {
    const order: string[] = [];
    let releaseToken: (value: string | null) => void = () => undefined;
    const waitForToken = vi.fn(() => {
      order.push('wait');
      return new Promise<string | null>((resolve) => {
        releaseToken = resolve;
      });
    });
    const fetcher = vi.fn(() => {
      order.push('fetch');
      return Promise.resolve('data');
    });

    const { result } = render(fetcher, {
      intervalMs: 60_000,
      auth: { waitForToken },
    });

    await settle();
    expect(waitForToken).toHaveBeenCalledTimes(1);
    expect(fetcher).not.toHaveBeenCalled();

    await act(async () => {
      releaseToken('token');
      await Promise.resolve();
    });

    await settle();
    expect(result.current.data).toBe('data');
    expect(order).toEqual(['wait', 'fetch']);
  });

  it('refetches when its query key is invalidated', async () => {
    const fetcher = sequence(['a', 'b']);
    const { result } = render(fetcher, {
      intervalMs: 60_000,
      queryKey: 'widgets',
    });

    await settle();
    expect(result.current.data).toBe('a');

    await act(async () => {
      invalidateQueries('widgets');
      await Promise.resolve();
    });

    await settle();
    expect(result.current.data).toBe('b');
  });

  it('refetches once immediately when the query key changes', async () => {
    const fetcher = sequence(['page-one', 'page-two']);
    const { result, rerender } = renderWithProps<string, number>(
      fetcher,
      (page: number) => ({ intervalMs: 60_000, queryKey: ['jobs', page] }),
      1
    );

    await settle();
    expect(result.current.data).toBe('page-one');
    expect(fetcher).toHaveBeenCalledTimes(1);

    rerender(2);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe('page-two');
  });

  it('resets data and isLoading while the new key is being read', async () => {
    let release: (value: string) => void = () => undefined;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce('page-one')
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            release = resolve;
          })
      );

    const { result, rerender } = renderWithProps<string, number>(
      fetcher,
      (page: number) => ({ intervalMs: 60_000, queryKey: ['jobs', page] }),
      1
    );

    await settle();
    expect(result.current.data).toBe('page-one');
    expect(result.current.isLoading).toBe(false);

    rerender(2);
    await settle();
    expect(result.current.data).toBeNull();
    expect(result.current.isLoading).toBe(true);
    expect(result.current.lastUpdatedAt).toBeNull();

    await act(async () => {
      release('page-two');
      await Promise.resolve();
    });
    await settle();
    expect(result.current.data).toBe('page-two');
    expect(result.current.isLoading).toBe(false);
  });

  it('does not restart when an inline array key keeps its segments', async () => {
    const fetcher = sequence(['a', 'b']);
    const { result, rerender } = renderWithProps(
      fetcher,
      () => ({ intervalMs: 60_000, queryKey: ['jobs', 1] }),
      'first'
    );

    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    rerender('second');
    rerender('third');
    await settle();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBe('a');
  });

  it('drops an in-flight result belonging to the previous key', async () => {
    let releaseOld: (value: string) => void = () => undefined;
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            releaseOld = resolve;
          })
      )
      .mockResolvedValue('new-key-data');

    const { result, rerender } = renderWithProps<string, number>(
      fetcher,
      (page: number) => ({ intervalMs: 60_000, queryKey: ['jobs', page] }),
      1
    );

    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    rerender(2);
    await settle();
    expect(result.current.data).toBe('new-key-data');

    await act(async () => {
      releaseOld('old-key-data');
      await Promise.resolve();
    });
    await settle();

    expect(result.current.data).toBe('new-key-data');
  });

  it('resets the timer so the new key polls from its own fetch', async () => {
    const fetcher = sequence(['a', 'b', 'c']);
    const { rerender } = renderWithProps<string, number>(
      fetcher,
      (page: number) => ({ intervalMs: 1000, queryKey: ['jobs', page] }),
      1
    );

    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    await advance(600);
    rerender(2);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);

    await advance(600);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);

    await advance(500);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('moves the refetch subscription to the new key', async () => {
    const fetcher = sequence(['a', 'b', 'c']);
    const { rerender } = renderWithProps<string, number>(
      fetcher,
      (page: number) => ({ intervalMs: 60_000, queryKey: ['jobs', page] }),
      1
    );

    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    rerender(2);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => {
      invalidateQueries(['jobs', 1]);
      await Promise.resolve();
    });
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => {
      invalidateQueries(['jobs', 2]);
      await Promise.resolve();
    });
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('serialises an array key by value rather than by identity', () => {
    expect(serializeQueryKey(['jobs', 1])).toBe(serializeQueryKey(['jobs', 1]));
    expect(serializeQueryKey(['jobs', 1])).not.toBe(
      serializeQueryKey(['jobs', 2])
    );
    expect(serializeQueryKey('jobs')).toBe('jobs');
  });

  it('unsubscribes its query key on unmount', async () => {
    const fetcher = sequence(['a']);
    const { result, unmount } = render(fetcher, {
      intervalMs: 60_000,
      queryKey: 'gadgets',
    });

    await settle();
    expect(result.current.data).toBe('a');
    unmount();

    await act(async () => {
      invalidateQueries('gadgets');
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('usePolledQuery stall recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A promise that never settles, standing in for a hung await. */
  function never<T>(): Promise<T> {
    return new Promise<T>(() => undefined);
  }

  it('times out a hung waitForToken and polls again', async () => {
    const waitForToken = vi.fn(() => never<string | null>());
    const fetcher = sequence(['data']);
    vi.spyOn(Math, 'random').mockReturnValue(1);

    const { result } = render(fetcher, {
      intervalMs: 1000,
      attemptTimeoutMs: 5000,
      auth: { waitForToken },
    });

    await settle();
    expect(result.current.isFetching).toBe(true);

    await advance(4999);
    expect(result.current.error).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();

    await advance(1);
    await settle();
    expect(result.current.error).toBeInstanceOf(PolledQueryTimeoutError);
    expect(result.current.isFetching).toBe(false);

    await advance(2000);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data).toBe('data');
    expect(result.current.error).toBeNull();
  });

  it('times out a hung token refresh inside a fetcher that ignores its signal', async () => {
    const refresh = vi.fn(() => never<string>());
    const fetcher = vi
      .fn<(context: { signal: AbortSignal }) => Promise<string>>()
      .mockImplementationOnce(async () => {
        await refresh();
        return 'unreachable';
      })
      .mockResolvedValue('fresh');
    vi.spyOn(Math, 'random').mockReturnValue(1);

    const { result } = render(fetcher, {
      intervalMs: 1000,
      attemptTimeoutMs: 5000,
    });

    await settle();
    const firstSignal = fetcher.mock.calls[0]?.[0].signal;
    expect(firstSignal?.aborted).toBe(false);

    await advance(5000);
    await settle();
    expect(firstSignal?.aborted).toBe(true);
    expect(firstSignal?.reason).toBeInstanceOf(PolledQueryTimeoutError);
    expect(result.current.error).toBeInstanceOf(PolledQueryTimeoutError);

    await advance(2000);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe('fresh');
  });

  it('times out a hung body read and releases the attempt', async () => {
    const hungBody = (): Response =>
      new Response(new ReadableStream({ start: () => undefined }), {
        headers: { 'content-type': 'application/json' },
      });
    const fetcher = vi
      .fn<(context: { signal: AbortSignal }) => Promise<unknown>>()
      .mockImplementationOnce(() => hungBody().json())
      .mockResolvedValue({ status: 'applied' });
    vi.spyOn(Math, 'random').mockReturnValue(1);

    const { result } = render(fetcher, {
      intervalMs: 1000,
      attemptTimeoutMs: 5000,
    });

    await settle();
    await act(async () => {
      void result.current.refetch();
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await advance(5000);
    await settle();
    expect(result.current.error).toBeInstanceOf(PolledQueryTimeoutError);

    await advance(2000);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.data).toEqual({ status: 'applied' });
  });

  it('never hands out an in-flight attempt past its deadline', async () => {
    const fetcher = vi
      .fn<(context: { signal: AbortSignal }) => Promise<string>>()
      .mockImplementationOnce(() => never<string>())
      .mockResolvedValue('second');

    const { result } = render(fetcher, {
      intervalMs: 60_000,
      attemptTimeoutMs: 5000,
    });

    await settle();
    expect(fetcher).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 6000);
    await act(async () => {
      await result.current.refetch();
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(result.current.data).toBe('second');
  });

  it('caps the backoff at 15 seconds by default', async () => {
    expect(DEFAULT_MAX_BACKOFF_MS).toBe(15_000);
    const fetcher = vi.fn().mockRejectedValue(new Error('down'));
    vi.spyOn(Math, 'random').mockReturnValue(1);

    render(fetcher, { intervalMs: 1000 });

    await settle();
    const delays = [2000, 4000, 8000, 15_000, 15_000, 15_000];
    for (const [index, delay] of delays.entries()) {
      await advance(delay - 1);
      expect(fetcher).toHaveBeenCalledTimes(index + 1);
      await advance(1);
      await settle();
      expect(fetcher).toHaveBeenCalledTimes(index + 2);
    }
  });

  it('never backs off below the interval', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('down'));
    vi.spyOn(Math, 'random').mockReturnValue(0);

    render(fetcher, { intervalMs: 10_000, maxBackoffMs: 2000 });

    await settle();
    await advance(9999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await advance(1);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('resets the backoff after a success', async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce('up')
      .mockRejectedValue(new Error('down'));
    vi.spyOn(Math, 'random').mockReturnValue(1);

    render(fetcher, { intervalMs: 1000 });

    await settle();
    await advance(2000 + 4000 + 8000);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(4);

    await advance(1000);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(5);
    await advance(2000);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('restarts a stalled poll when no attempt has progressed', async () => {
    const fetcher = vi
      .fn<(context: { signal: AbortSignal }) => Promise<string>>()
      .mockImplementationOnce(() => never<string>())
      .mockResolvedValue('recovered');

    const { result } = render(fetcher, {
      intervalMs: 1000,
      attemptTimeoutMs: 0,
      stallTimeoutMs: 10_000,
    });

    await settle();
    await advance(10_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await advance(2500);
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(result.current.data).toBe('recovered');
  });

  it('holds the watchdog while hidden and restarts on the way back to visible', async () => {
    const fetcher = vi
      .fn<(context: { signal: AbortSignal }) => Promise<string>>()
      .mockImplementationOnce(() => never<string>())
      .mockResolvedValue('resumed');

    const { result } = render(fetcher, {
      intervalMs: 1000,
      attemptTimeoutMs: 0,
      stallTimeoutMs: 10_000,
    });

    await settle();
    await act(async () => {
      setVisibility('hidden');
      await Promise.resolve();
    });
    await advance(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      setVisibility('visible');
      await Promise.resolve();
    });
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(result.current.data).toBe('resumed');
  });

  it('starts a new attempt on resume when the old deadline passed while hidden', async () => {
    const fetcher = vi
      .fn<(context: { signal: AbortSignal }) => Promise<string>>()
      .mockImplementationOnce(() => never<string>())
      .mockResolvedValue('resumed');

    const { result } = render(fetcher, {
      intervalMs: 1000,
      attemptTimeoutMs: 5000,
    });

    await settle();
    await act(async () => {
      setVisibility('hidden');
      await Promise.resolve();
    });
    vi.setSystemTime(Date.now() + 6000);

    await act(async () => {
      setVisibility('visible');
      await Promise.resolve();
    });
    await settle();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.data).toBe('resumed');
  });

  it('clears its timers and listeners on unmount', async () => {
    const fetcher = vi
      .fn<(context: { signal: AbortSignal }) => Promise<string>>()
      .mockImplementation(() => never<string>());

    const { unmount } = render(fetcher, {
      intervalMs: 1000,
      attemptTimeoutMs: 5000,
      stallTimeoutMs: 10_000,
    });

    await settle();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    expect(fetcher.mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    await act(async () => {
      setVisibility('hidden');
      setVisibility('visible');
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    await advance(60_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('useMutationWithRefetch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('invalidates the keys after the write lands', async () => {
    const fetcher = sequence(['a', 'b']);
    const query = renderHook(() =>
      usePolledQuery(fetcher, { intervalMs: 60_000, queryKey: 'items' })
    );

    await settle();
    expect(query.result.current.data).toBe('a');

    const write = vi.fn(() => Promise.resolve('written'));
    const mutation = renderHook(() => useMutationWithRefetch(write, 'items'));

    await act(async () => {
      await mutation.result.current.mutate();
    });

    await settle();
    expect(query.result.current.data).toBe('b');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('invalidates an array key the query is reading', async () => {
    const fetcher = sequence(['a', 'b']);
    const query = renderHook(() =>
      usePolledQuery(fetcher, { intervalMs: 60_000, queryKey: ['items', 3] })
    );

    await settle();
    expect(query.result.current.data).toBe('a');

    const write = vi.fn(() => Promise.resolve('written'));
    const mutation = renderHook(() =>
      useMutationWithRefetch(write, ['items', 3])
    );

    await act(async () => {
      await mutation.result.current.mutate();
    });

    await settle();
    expect(query.result.current.data).toBe('b');
  });

  it('reads its keys when the write runs, not when it renders', async () => {
    const fetcher = sequence(['a', 'b']);
    const query = renderHook(() =>
      usePolledQuery(fetcher, { intervalMs: 60_000, queryKey: ['items', 9] })
    );

    await settle();
    expect(query.result.current.data).toBe('a');

    const write = vi.fn(() => Promise.resolve('written'));
    const mutation = renderHook<
      ReturnType<typeof useMutationWithRefetch<[], string>>,
      number
    >((page) => useMutationWithRefetch(write, ['items', page]), {
      initialProps: 1,
    });

    mutation.rerender(9);

    await act(async () => {
      await mutation.result.current.mutate();
    });

    await settle();
    expect(query.result.current.data).toBe('b');
  });

  it('invalidates several keys given a list holding an array key', async () => {
    const first = sequence(['a1', 'a2']);
    const second = sequence(['b1', 'b2']);
    const one = renderHook(() =>
      usePolledQuery(first, { intervalMs: 60_000, queryKey: ['rows', 1] })
    );
    const two = renderHook(() =>
      usePolledQuery(second, { intervalMs: 60_000, queryKey: 'counts' })
    );

    await settle();
    expect(one.result.current.data).toBe('a1');
    expect(two.result.current.data).toBe('b1');

    const write = vi.fn(() => Promise.resolve('written'));
    const mutation = renderHook(() =>
      useMutationWithRefetch(write, [['rows', 1], 'counts'])
    );

    await act(async () => {
      await mutation.result.current.mutate();
    });

    await settle();
    expect(one.result.current.data).toBe('a2');
    expect(two.result.current.data).toBe('b2');
  });

  it('does not invalidate when the write rejects', async () => {
    const fetcher = sequence(['a']);
    const query = renderHook(() =>
      usePolledQuery(fetcher, { intervalMs: 60_000, queryKey: 'rows' })
    );

    await settle();
    expect(query.result.current.data).toBe('a');

    const write = vi.fn(() => Promise.reject(new Error('refused')));
    const mutation = renderHook(() => useMutationWithRefetch(write, 'rows'));

    await act(async () => {
      await expect(mutation.result.current.mutate()).rejects.toThrow('refused');
    });

    expect(mutation.result.current.error).toBeInstanceOf(Error);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
