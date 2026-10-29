import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createApiClient } from './client.js';
import {
  configureReachability,
  isOnline,
  reportNetworkFailure,
  reportNetworkSuccess,
  subscribeToOnline,
} from './online.js';
import {
  createIndexedDbQueryStore,
  createMemoryQueryCacheStore,
  type PersistedQuery,
  type QueryCacheStore,
} from './persist.js';

/** A record with the given key and read time. */
function record(key: string, fetchedAt = 1_000): PersistedQuery {
  return { key, data: { key }, etag: `W/"${key}"`, fetchedAt, version: 1 };
}

/** A fresh IndexedDB store on its own fake factory. */
function indexedDbStore(): Required<QueryCacheStore> {
  const store = createIndexedDbQueryStore({ indexedDB: new IDBFactory() });
  if (store === undefined) {
    throw new Error('expected a store');
  }
  return store;
}

/** Sorts records by key so assertions do not depend on store order. */
function byKey(records: PersistedQuery[]): PersistedQuery[] {
  return [...records].sort((a, b) => a.key.localeCompare(b.key));
}

describe('createIndexedDbQueryStore', () => {
  it('is undefined without IndexedDB, as during server rendering', () => {
    expect(globalThis.indexedDB).toBeUndefined();
    expect(createIndexedDbQueryStore()).toBeUndefined();
  });

  it('round trips records under a namespace', async () => {
    const store = indexedDbStore();
    await store.save('u1:w1', [record('a'), record('["issues",1]', 2_000)]);

    expect(byKey(await store.load('u1:w1'))).toEqual([
      record('["issues",1]', 2_000),
      record('a'),
    ]);
  });

  it('replaces a record on the same key', async () => {
    const store = indexedDbStore();
    await store.save('ns', [record('a', 1)]);
    await store.save('ns', [record('a', 2)]);

    expect(await store.load('ns')).toEqual([record('a', 2)]);
  });

  it('keeps namespaces apart on load, remove and clear', async () => {
    const store = indexedDbStore();
    await store.save('one', [record('a'), record('b')]);
    await store.save('two', [record('a')]);

    await store.remove('one', ['a']);
    expect(await store.load('one')).toEqual([record('b')]);
    expect(await store.load('two')).toEqual([record('a')]);

    await store.clear('two');
    expect(await store.load('two')).toEqual([]);
    expect(await store.load('one')).toEqual([record('b')]);
  });

  it('lists every namespace once and clears them all', async () => {
    const store = indexedDbStore();
    expect(await store.listNamespaces()).toEqual([]);
    await store.save('one', [record('a'), record('b')]);
    await store.save('two', [record('a')]);

    expect((await store.listNamespaces()).sort()).toEqual(['one', 'two']);

    await store.clearAll();
    expect(await store.listNamespaces()).toEqual([]);
    expect(await store.load('one')).toEqual([]);
    expect(await store.load('two')).toEqual([]);
  });

  it('rejects a value that cannot be cloned without losing the store', async () => {
    const store = indexedDbStore();
    await store.save('ns', [record('a')]);

    await expect(
      store.save('ns', [{ ...record('b'), data: () => undefined }])
    ).rejects.toThrow();
    expect(await store.load('ns')).toEqual([record('a')]);
  });

  it('rejects every call when the database cannot be opened', async () => {
    const factory = new IDBFactory();
    factory.open = () => {
      throw new DOMException('blocked', 'SecurityError');
    };
    const store = createIndexedDbQueryStore({ indexedDB: factory });

    await expect(store?.load('ns')).rejects.toThrow('blocked');
    await expect(store?.save('ns', [record('a')])).rejects.toThrow('blocked');
  });
});

describe('createMemoryQueryCacheStore', () => {
  it('round trips, removes and clears per namespace', async () => {
    const store = createMemoryQueryCacheStore();
    await store.save('one', [record('a'), record('b')]);
    await store.save('two', [record('a')]);
    await store.remove('one', ['b']);
    await store.clear('two');

    expect(await store.load('one')).toEqual([record('a')]);
    expect(await store.load('two')).toEqual([]);
  });

  it('lists only namespaces holding records and clears them all', async () => {
    const store = createMemoryQueryCacheStore();
    await store.save('one', [record('a')]);
    await store.save('two', [record('a')]);
    await store.remove('two', ['a']);

    expect(await store.listNamespaces()).toEqual(['one']);

    await store.clearAll();
    expect(await store.listNamespaces()).toEqual([]);
    expect(await store.load('one')).toEqual([]);
  });
});

describe('online signal', () => {
  beforeEach(() => {
    configureReachability({ graceMs: 0, probe: false });
  });

  afterEach(() => {
    reportNetworkSuccess();
    configureReachability();
  });

  it('goes offline on a network failure and back on a response', () => {
    reportNetworkSuccess();
    const seen: boolean[] = [];
    const unsubscribe = subscribeToOnline((online) => seen.push(online));

    expect(isOnline()).toBe(true);
    reportNetworkFailure();
    reportNetworkFailure();
    expect(isOnline()).toBe(false);
    reportNetworkSuccess();
    reportNetworkSuccess();
    expect(isOnline()).toBe(true);
    expect(seen).toEqual([false, true]);

    unsubscribe();
  });

  it('is fed by the client on network failures and responses', async () => {
    reportNetworkSuccess();
    let fail = true;
    const client = createApiClient({
      baseUrl: 'https://api.test',
      retries: 0,
      fetch: () =>
        fail
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve(new Response(null, { status: 503 })),
    });

    await expect(client.get('/x')).rejects.toThrow();
    expect(isOnline()).toBe(false);

    fail = false;
    await expect(client.get('/x')).rejects.toThrow();
    expect(isOnline()).toBe(true);
  });
});
