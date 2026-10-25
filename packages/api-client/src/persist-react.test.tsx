import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearPersistedPolledQueries,
  clearPolledQueryCache,
  createIndexedDbQueryStore,
  createMemoryQueryCacheStore,
  persistPolledQueryCache,
  polledResponse,
  prefetchPolledQuery,
  reportNetworkFailure,
  reportNetworkSuccess,
  serializeQueryKey,
  useOnline,
  usePolledQuery,
  type PersistedQuery,
  type PersistPolledQueryCacheOptions,
  type PolledQueryContext,
  type PolledQueryPersistence,
  type QueryCacheStore,
} from './react.js';

const NAMESPACE = 'user-1:workspace-1';

const ISSUES = serializeQueryKey(['issues', 'open']);

let running: PolledQueryPersistence | undefined;

/** Starts a persister and remembers it for the teardown. */
function persist(
  options: Partial<PersistPolledQueryCacheOptions> & { store: QueryCacheStore }
): PolledQueryPersistence {
  running = persistPolledQueryCache({
    namespace: NAMESPACE,
    prefixes: ['issues'],
    writeDelayMs: 0,
    ...options,
  });
  return running;
}

/** A stored record for `key`, read `ageMs` ago. */
function record(
  key: string,
  data: unknown,
  ageMs = 1_000,
  version: string | number = 1
): PersistedQuery {
  return {
    key,
    data,
    etag: `W/"${key}"`,
    fetchedAt: Date.now() - ageMs,
    version,
  };
}

/** A fetcher answering with `data` and an ETag, or 304 to a matching validator. */
function etagFetcher(data: unknown, etag = 'W/"fresh"') {
  return vi.fn((context: PolledQueryContext) =>
    Promise.resolve(
      polledResponse({
        data,
        status: context.etag === undefined ? 200 : 304,
        headers: new Headers({ etag }),
      })
    )
  );
}

/** A response with an ETag, for prefetching a key. */
function answer<T>(data: T, etag = 'W/"1"') {
  return () =>
    Promise.resolve(
      polledResponse({ data, status: 200, headers: new Headers({ etag }) })
    );
}

/** An IndexedDB store on `factory`. */
function idbStore(factory: IDBFactory): QueryCacheStore {
  const store = createIndexedDbQueryStore({ indexedDB: factory });
  if (store === undefined) {
    throw new Error('expected a store');
  }
  return store;
}

/** A store whose calls fail, as in private mode or over quota. */
function failingStore(fail: 'load' | 'save'): QueryCacheStore {
  const store = createMemoryQueryCacheStore();
  return {
    ...store,
    load: (namespace) =>
      fail === 'load'
        ? Promise.reject(new DOMException('denied', 'InvalidStateError'))
        : store.load(namespace),
    save: () => Promise.reject(new DOMException('full', 'QuotaExceededError')),
  };
}

afterEach(() => {
  cleanup();
  running?.stop();
  running = undefined;
  clearPolledQueryCache();
  reportNetworkSuccess();
});

describe('persistPolledQueryCache', () => {
  it('hydrates before the first fetch and revalidates with the stored ETag', async () => {
    const store = createMemoryQueryCacheStore();
    await store.save(NAMESPACE, [record(ISSUES, ['stored'])]);
    await persist({ store }).ready;

    const fetcher = etagFetcher(['network']);
    const { result } = renderHook(() =>
      usePolledQuery(fetcher, { queryKey: ['issues', 'open'] })
    );

    expect(result.current.data).toEqual(['stored']);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isStale).toBe(true);
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
    expect(fetcher.mock.calls[0]?.[0].etag).toBe(`W/"${ISSUES}"`);
    await waitFor(() => {
      expect(result.current.isFetching).toBe(false);
    });
    expect(result.current.data).toEqual(['stored']);
  });

  it('hands stored data to a query mounted before the load finished', async () => {
    const memory = createMemoryQueryCacheStore();
    await memory.save(NAMESPACE, [record(ISSUES, ['stored'])]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store: QueryCacheStore = {
      ...memory,
      load: async (namespace) => {
        await gate;
        return memory.load(namespace);
      },
    };
    const persistence = persist({ store });
    const fetcher = vi.fn(() => new Promise<string[]>(() => undefined));
    const { result } = renderHook(() =>
      usePolledQuery(fetcher, { queryKey: ['issues', 'open'] })
    );
    expect(result.current.data).toBeNull();

    release();
    await act(() => persistence.ready);

    expect(result.current.data).toEqual(['stored']);
    expect(result.current.isLoading).toBe(false);
  });

  it('writes only keys under the listed prefixes, with data, ETag and read time', async () => {
    const store = createMemoryQueryCacheStore();
    const persistence = persist({
      store,
      prefixes: ['issues', ['projects', 1]],
    });
    await persistence.ready;

    await prefetchPolledQuery(['issues', 'open'], answer(['a'], 'W/"a"'));
    await prefetchPolledQuery('issues', answer(['all']));
    await prefetchPolledQuery(['projects', 1, 'x'], answer('p1'));
    await prefetchPolledQuery(['projects', 2], answer('p2'));
    await prefetchPolledQuery(['secrets'], answer('nope'));
    await prefetchPolledQuery('issues-archive', answer('nope'));
    await persistence.flush();

    const saved = await store.load(NAMESPACE);
    expect(saved.map((query) => query.key).sort()).toEqual(
      ['issues', ISSUES, serializeQueryKey(['projects', 1, 'x'])].sort()
    );
    const issues = saved.find((query) => query.key === ISSUES);
    expect(issues).toMatchObject({ data: ['a'], etag: 'W/"a"', version: 1 });
    expect(typeof issues?.fetchedAt).toBe('number');
  });

  it('debounces writes into one save', async () => {
    const memory = createMemoryQueryCacheStore();
    const save = vi.fn(
      (namespace: string, queries: readonly PersistedQuery[]) =>
        memory.save(namespace, queries)
    );
    const store = { ...memory, save };
    await persist({ store, writeDelayMs: 20 }).ready;

    await prefetchPolledQuery(['issues', 1], answer(1));
    await prefetchPolledQuery(['issues', 2], answer(2));
    expect(save).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    expect(save.mock.calls[0]?.[1]).toHaveLength(2);
  });

  it('drops records from another version, past the max age or no longer listed', async () => {
    const store = createMemoryQueryCacheStore();
    const keep = serializeQueryKey(['issues', 'keep']);
    await store.save(NAMESPACE, [
      record(keep, 'kept', 1_000, 2),
      record(serializeQueryKey(['issues', 'old']), 'old', 1_000, 1),
      record(serializeQueryKey(['issues', 'aged']), 'aged', 120_000, 2),
      record(serializeQueryKey(['other']), 'other', 1_000, 2),
    ]);

    await persist({ store, version: 2, maxAgeMs: 60_000 }).ready;

    expect((await store.load(NAMESPACE)).map((query) => query.key)).toEqual([
      keep,
    ]);
    const { result } = renderHook(() =>
      usePolledQuery(() => new Promise<string>(() => undefined), {
        queryKey: ['issues', 'aged'],
      })
    );
    expect(result.current.data).toBeNull();
  });

  it('keeps the most recently read entries up to the cap', async () => {
    const store = createMemoryQueryCacheStore();
    await store.save(NAMESPACE, [
      record(serializeQueryKey(['issues', 1]), 1, 3_000),
      record(serializeQueryKey(['issues', 2]), 2, 2_000),
      record(serializeQueryKey(['issues', 3]), 3, 1_000),
    ]);
    const persistence = persist({ store, maxEntries: 2 });
    await persistence.ready;
    expect(
      (await store.load(NAMESPACE)).map((query) => query.key).sort()
    ).toEqual(
      [
        serializeQueryKey(['issues', 2]),
        serializeQueryKey(['issues', 3]),
      ].sort()
    );

    await prefetchPolledQuery(['issues', 4], answer(4));
    await persistence.flush();

    expect(
      (await store.load(NAMESPACE)).map((query) => query.key).sort()
    ).toEqual(
      [
        serializeQueryKey(['issues', 3]),
        serializeQueryKey(['issues', 4]),
      ].sort()
    );
  });

  it('skips an entry over the size cap and deletes its older copy', async () => {
    const store = createMemoryQueryCacheStore();
    const key = serializeQueryKey(['issues', 'big']);
    await store.save(NAMESPACE, [record(key, 'small')]);
    const persistence = persist({ store, maxEntryBytes: 50 });
    await persistence.ready;

    clearPolledQueryCache();
    await prefetchPolledQuery(['issues', 'big'], answer('x'.repeat(100)));
    await persistence.flush();

    expect(await store.load(NAMESPACE)).toEqual([]);
  });

  it('clear() deletes the namespace and stops writing', async () => {
    const store = createMemoryQueryCacheStore();
    await store.save(NAMESPACE, [record(ISSUES, ['stored'])]);
    await store.save('someone-else', [record(ISSUES, ['theirs'])]);
    const persistence = persist({ store });
    await persistence.ready;

    await persistence.clear();
    expect(persistence.active).toBe(false);
    await prefetchPolledQuery(['issues', 'new'], answer('new'));
    await persistence.flush();

    expect(await store.load(NAMESPACE)).toEqual([]);
    expect(await store.load('someone-else')).toHaveLength(1);
  });

  it('clearPersistedPolledQueries(namespace) clears through the running persister', async () => {
    const store = createMemoryQueryCacheStore();
    await store.save(NAMESPACE, [record(ISSUES, ['stored'])]);
    const persistence = persist({ store });
    await persistence.ready;

    await clearPersistedPolledQueries(NAMESPACE);

    expect(persistence.active).toBe(false);
    expect(await store.load(NAMESPACE)).toEqual([]);
  });

  it('a second persister stops the first', async () => {
    const first = persist({ store: createMemoryQueryCacheStore() });
    const second = persist({
      store: createMemoryQueryCacheStore(),
      namespace: 'user-1:workspace-2',
    });

    expect(first.active).toBe(false);
    expect(second.active).toBe(true);
    await second.ready;
  });

  it('falls back to memory when the load fails', async () => {
    const persistence = persist({ store: failingStore('load') });

    await expect(persistence.ready).resolves.toBeUndefined();
    expect(persistence.active).toBe(false);
    await prefetchPolledQuery(['issues', 1], answer(1));
    await expect(persistence.flush()).resolves.toBeUndefined();
  });

  it('falls back to memory when a write fails', async () => {
    const persistence = persist({ store: failingStore('save') });
    await persistence.ready;

    await prefetchPolledQuery(['issues', 1], answer(1));
    await expect(persistence.flush()).resolves.toBeUndefined();

    expect(persistence.active).toBe(false);
  });

  it('stays off without IndexedDB', async () => {
    expect(createIndexedDbQueryStore()).toBeUndefined();
    running = persistPolledQueryCache({
      namespace: NAMESPACE,
      prefixes: ['issues'],
    });

    expect(running.active).toBe(false);
    await expect(running.ready).resolves.toBeUndefined();
    await expect(running.clear()).resolves.toBeUndefined();
    await expect(clearPersistedPolledQueries('other')).resolves.toBeUndefined();
  });

  it('survives a reload through IndexedDB', async () => {
    const factory = new IDBFactory();
    const first = persist({ store: idbStore(factory) });
    await first.ready;
    await prefetchPolledQuery(
      ['issues', 'open'],
      answer(['persisted'], 'W/"p"')
    );
    await first.flush();
    first.stop();
    clearPolledQueryCache();

    await persist({ store: idbStore(factory) }).ready;
    const fetcher = etagFetcher(['network']);
    const { result } = renderHook(() =>
      usePolledQuery(fetcher, { queryKey: ['issues', 'open'] })
    );

    expect(result.current.data).toEqual(['persisted']);
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
    expect(fetcher.mock.calls[0]?.[0].etag).toBe('W/"p"');
  });
});

describe('useOnline', () => {
  it('follows network failures, responses and browser events', () => {
    const { result } = renderHook(() => useOnline());
    expect(result.current).toBe(true);

    act(() => {
      reportNetworkFailure();
    });
    expect(result.current).toBe(false);

    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(result.current).toBe(true);
  });
});
