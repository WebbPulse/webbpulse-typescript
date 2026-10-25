/**
 * Durable storage for the polled query cache, so a reload can paint what was
 * last read before the network answers. Framework free: the React entry's
 * `persistPolledQueryCache` decides what to write and when, and this module
 * only reads and writes records. Nothing here runs until a store is created.
 */

/** One persisted cache entry. */
export interface PersistedQuery {
  /** The serialised query key, as `serializeQueryKey` builds it. */
  key: string;
  /** The data last read for the key. Must survive a structured clone. */
  data: unknown;
  /** The ETag the data was read with, or undefined. */
  etag: string | undefined;
  /** When the data was last read or revalidated, in epoch milliseconds. */
  fetchedAt: number;
  /** The caller's schema version the record was written under. */
  version: string | number;
}

/**
 * Where persisted entries live, grouped by a caller-chosen namespace such as
 * the user and workspace. Any method may reject; the persister treats a
 * rejection as storage being unavailable and carries on in memory.
 */
export interface QueryCacheStore {
  /** Every record held under `namespace`. */
  load(namespace: string): Promise<PersistedQuery[]>;
  /** Writes `queries` under `namespace`, replacing records on the same key. */
  save(namespace: string, queries: readonly PersistedQuery[]): Promise<void>;
  /** Deletes the records on `keys` under `namespace`. */
  remove(namespace: string, keys: readonly string[]): Promise<void>;
  /** Deletes every record under `namespace`, leaving other namespaces alone. */
  clear(namespace: string): Promise<void>;
}

/** The IndexedDB database the default store opens. */
export const QUERY_CACHE_DATABASE_NAME = 'webbpulse-query-cache';

const OBJECT_STORE = 'queries';
const NAMESPACE_INDEX = 'namespace';
const DATABASE_VERSION = 1;

/** Options for {@link createIndexedDbQueryStore}. */
export interface IndexedDbQueryStoreOptions {
  /** The database name. Defaults to {@link QUERY_CACHE_DATABASE_NAME}. */
  databaseName?: string;
  /** The IndexedDB factory. Defaults to `globalThis.indexedDB`. */
  indexedDB?: IDBFactory;
}

/** A record as it sits in the object store. */
interface StoredRecord extends PersistedQuery {
  namespace: string;
}

/** The global IndexedDB factory, or undefined where it is missing or blocked. */
function globalFactory(): IDBFactory | undefined {
  try {
    return typeof globalThis.indexedDB === 'undefined'
      ? undefined
      : globalThis.indexedDB;
  } catch {
    return undefined;
  }
}

/** The error a failed request or transaction carries, or a generic one. */
function failure(error: DOMException | null, message: string): Error {
  return error ?? new Error(message);
}

/** Coerces a thrown value to an `Error`. */
function asError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

/** Aborts a transaction that may already have finished. */
function abortQuietly(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    return;
  }
}

/** Resolves with a request's result. */
function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(failure(request.error, 'IndexedDB request failed.'));
    };
  });
}

/** Resolves once a transaction commits. */
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => {
      resolve();
    };
    transaction.onerror = () => {
      reject(failure(transaction.error, 'IndexedDB transaction failed.'));
    };
    transaction.onabort = () => {
      reject(failure(transaction.error, 'IndexedDB transaction aborted.'));
    };
  });
}

/** Opens the database, creating the object store on first use. */
function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(name, DATABASE_VERSION);
    } catch (thrown) {
      reject(asError(thrown));
      return;
    }
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(OBJECT_STORE)) {
        const store = database.createObjectStore(OBJECT_STORE, {
          keyPath: ['namespace', 'key'],
        });
        store.createIndex(NAMESPACE_INDEX, 'namespace');
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
      };
      resolve(database);
    };
    request.onerror = () => {
      reject(failure(request.error, 'IndexedDB open failed.'));
    };
    request.onblocked = () => {
      reject(new Error('IndexedDB open was blocked.'));
    };
  });
}

/** Whether a stored value has the shape of a record. */
function isRecord(value: unknown): value is StoredRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<StoredRecord>;
  return (
    typeof record.key === 'string' &&
    typeof record.fetchedAt === 'number' &&
    (typeof record.version === 'string' ||
      typeof record.version === 'number') &&
    (record.etag === undefined || typeof record.etag === 'string')
  );
}

/** The IndexedDB backed {@link QueryCacheStore}. */
class IndexedDbQueryStore implements QueryCacheStore {
  private readonly factory: IDBFactory;
  private readonly name: string;
  private connection: Promise<IDBDatabase> | undefined;

  constructor(factory: IDBFactory, name: string) {
    this.factory = factory;
    this.name = name;
  }

  /** The open database, opened once and reopened after it closes. */
  private database(): Promise<IDBDatabase> {
    this.connection ??= openDatabase(this.factory, this.name).then(
      (database) => {
        database.onclose = () => {
          this.connection = undefined;
        };
        return database;
      },
      (thrown: unknown) => {
        this.connection = undefined;
        throw asError(thrown);
      }
    );
    return this.connection;
  }

  /**
   * Runs `body` in one read-write transaction and resolves once it commits. A
   * throw from `body`, such as a value that cannot be cloned, aborts the
   * transaction and rejects with that error.
   */
  private async write(body: (store: IDBObjectStore) => void): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(OBJECT_STORE, 'readwrite');
    const done = committed(transaction);
    try {
      body(transaction.objectStore(OBJECT_STORE));
    } catch (thrown) {
      done.catch(() => undefined);
      abortQuietly(transaction);
      throw asError(thrown);
    }
    return done;
  }

  /** Reads every well-formed record under `namespace`. */
  async load(namespace: string): Promise<PersistedQuery[]> {
    const database = await this.database();
    const transaction = database.transaction(OBJECT_STORE, 'readonly');
    const index = transaction.objectStore(OBJECT_STORE).index(NAMESPACE_INDEX);
    const rows: unknown[] = await settle(index.getAll(namespace));
    return rows
      .filter(isRecord)
      .map(({ key, data, etag, fetchedAt, version }) => ({
        key,
        data,
        etag,
        fetchedAt,
        version,
      }));
  }

  /** Puts every query in one transaction. */
  save(namespace: string, queries: readonly PersistedQuery[]): Promise<void> {
    return this.write((store) => {
      for (const query of queries) {
        const record: StoredRecord = { ...query, namespace };
        store.put(record);
      }
    });
  }

  /** Deletes the keys in one transaction. */
  remove(namespace: string, keys: readonly string[]): Promise<void> {
    return this.write((store) => {
      for (const key of keys) {
        store.delete([namespace, key]);
      }
    });
  }

  /** Deletes the namespace's records through the namespace index. */
  clear(namespace: string): Promise<void> {
    return this.write((store) => {
      const request = store.index(NAMESPACE_INDEX).getAllKeys(namespace);
      request.onsuccess = () => {
        for (const key of request.result) {
          store.delete(key);
        }
      };
    });
  }
}

/**
 * The IndexedDB store, or undefined where IndexedDB is missing or blocked, as
 * during server rendering, so the caller stays memory only. The database is
 * opened on first use, not here.
 */
export function createIndexedDbQueryStore(
  options: IndexedDbQueryStoreOptions = {}
): QueryCacheStore | undefined {
  const factory = options.indexedDB ?? globalFactory();
  if (factory === undefined) {
    return undefined;
  }
  return new IndexedDbQueryStore(
    factory,
    options.databaseName ?? QUERY_CACHE_DATABASE_NAME
  );
}

/**
 * An in-memory {@link QueryCacheStore}, for tests and for a caller that wants
 * the persister's shape without durable storage.
 */
export function createMemoryQueryCacheStore(): QueryCacheStore {
  const namespaces = new Map<string, Map<string, PersistedQuery>>();
  const bucket = (namespace: string): Map<string, PersistedQuery> => {
    let held = namespaces.get(namespace);
    if (held === undefined) {
      held = new Map();
      namespaces.set(namespace, held);
    }
    return held;
  };
  return {
    load(namespace) {
      return Promise.resolve(
        [...(namespaces.get(namespace)?.values() ?? [])].map((query) => ({
          ...query,
        }))
      );
    },
    save(namespace, queries) {
      const held = bucket(namespace);
      for (const query of queries) {
        held.set(query.key, { ...query });
      }
      return Promise.resolve();
    },
    remove(namespace, keys) {
      const held = namespaces.get(namespace);
      for (const key of keys) {
        held?.delete(key);
      }
      return Promise.resolve();
    },
    clear(namespace) {
      namespaces.delete(namespace);
      return Promise.resolve();
    },
  };
}
