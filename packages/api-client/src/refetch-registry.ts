/**
 * The in-memory bus a write uses to tell the polled queries reading the same
 * data to go again. Framework free and module scoped: a key is a plain string,
 * and nothing here holds a response, so this is a notification channel rather
 * than a cache.
 */

/** Removes a subscription. Calling it twice is safe. */
export type Unsubscribe = () => void;

/** A key naming the data a query reads, for example `build-lists`. */
export type QueryKey = string;

const subscribers = new Map<QueryKey, Set<() => void>>();

/**
 * Registers `listener` against `key`, returning its unsubscribe. Several
 * queries may share one key, and all of them are notified together.
 */
export function subscribeToRefetch(
  key: QueryKey,
  listener: () => void
): Unsubscribe {
  let listeners = subscribers.get(key);
  if (listeners === undefined) {
    listeners = new Set();
    subscribers.set(key, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = subscribers.get(key);
    if (current === undefined) {
      return;
    }
    current.delete(listener);
    if (current.size === 0) {
      subscribers.delete(key);
    }
  };
}

/**
 * Tells every query registered against each key to refetch. Unknown keys are
 * ignored, so a write may name a key nothing is currently reading. Listeners
 * are copied before the walk, so one that unsubscribes while being notified
 * does not perturb the iteration.
 */
export function invalidateQueries(keys: QueryKey | readonly QueryKey[]): void {
  const list = typeof keys === 'string' ? [keys] : keys;
  for (const key of list) {
    const listeners = subscribers.get(key);
    if (listeners === undefined) {
      continue;
    }
    for (const listener of [...listeners]) {
      listener();
    }
  }
}
