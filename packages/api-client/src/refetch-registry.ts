/**
 * The in-memory bus a write uses to tell the polled queries reading the same
 * data to go again. Framework free and module scoped: nothing here holds a
 * response, so this is a notification channel rather than a cache.
 *
 * A key is a string or an array of primitives, and subscriptions are held
 * against its serialisation rather than its identity, so a call site may build
 * `['jobs', page, filter]` inline on every render without losing its listener.
 */

/** Removes a subscription. Calling it twice is safe. */
export type Unsubscribe = () => void;

/** A single segment of an array {@link QueryKey}. */
export type QueryKeyPart = string | number | boolean | null | undefined;

/**
 * A key naming the data a query reads, for example `build-lists` or
 * `['build-lists', page]`. An array key is compared by value, so the filters
 * and cursors a list is reading can live in the key itself.
 */
export type QueryKey = string | readonly QueryKeyPart[];

/**
 * Serialises a key to the stable string the registry and the hooks compare on.
 * Two keys with equal segments serialise alike whatever their identity, and a
 * string key serialises to itself so the plain form stays readable in a
 * debugger.
 */
export function serializeQueryKey(key: QueryKey): string {
  if (typeof key === 'string') {
    return key;
  }
  return JSON.stringify(key.map((part) => (part === undefined ? null : part)));
}

/**
 * Whether `value` is one key rather than a list of them. An array of
 * primitives is a single array key; a list of keys holds at least one array or
 * is empty.
 */
function isSingleKey(value: QueryKey | readonly QueryKey[]): value is QueryKey {
  if (typeof value === 'string') {
    return true;
  }
  return value.length > 0 && value.every((part) => !Array.isArray(part));
}

const subscribers = new Map<string, Set<() => void>>();

/**
 * Registers `listener` against `key`, returning its unsubscribe. Several
 * queries may share one key, and all of them are notified together.
 */
export function subscribeToRefetch(
  key: QueryKey,
  listener: () => void
): Unsubscribe {
  const serialized = serializeQueryKey(key);
  let listeners = subscribers.get(serialized);
  if (listeners === undefined) {
    listeners = new Set();
    subscribers.set(serialized, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = subscribers.get(serialized);
    if (current === undefined) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      subscribers.delete(serialized);
    }
  };
}

/**
 * Tells every query registered against each key to refetch. Unknown keys are
 * ignored, so a write may name a key nothing is currently reading. Listeners
 * are copied before the walk, so one that unsubscribes while being notified
 * does not perturb the iteration.
 *
 * An array of primitives is read as one array key, so `['jobs', 1]` invalidates
 * that key rather than the two keys `jobs` and `1`. Pass a list of keys as an
 * array holding at least one array key, for example `[['jobs', 1], 'counts']`.
 */
export function invalidateQueries(keys: QueryKey | readonly QueryKey[]): void {
  const list: readonly QueryKey[] = isSingleKey(keys) ? [keys] : keys;
  for (const key of list) {
    const listeners = subscribers.get(serializeQueryKey(key));
    if (listeners === undefined) {
      continue;
    }
    for (const listener of [...listeners]) {
      listener();
    }
  }
}
