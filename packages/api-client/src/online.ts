/**
 * Whether the app can reach its API, shared by every client and hook. Combines
 * the browser's `navigator.onLine` with what requests report: a fetch that
 * fails at the network layer marks the app offline until a response arrives or
 * the browser fires `online`. Framework free, and outside a browser it starts
 * online and moves only on what requests report.
 */

import type { Unsubscribe } from './refetch-registry.js';

const listeners = new Set<(online: boolean) => void>();
let networkDown = false;
let lastReported: boolean | undefined;

/** What the browser says, or true where there is no `navigator.onLine`. */
function browserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * Whether the app is online: the browser reports a connection and no request
 * has failed at the network layer since the last response or `online` event.
 */
export function isOnline(): boolean {
  return browserOnline() && !networkDown;
}

/** Tells every subscriber when the combined state has changed. */
function emit(): void {
  const online = isOnline();
  if (online === lastReported) {
    return;
  }
  lastReported = online;
  for (const listener of [...listeners]) {
    listener(online);
  }
}

/** Trusts a browser `online` event over an earlier failed request. */
function onBrowserOnline(): void {
  networkDown = false;
  emit();
}

/** Re-reads the state on a browser `offline` event. */
function onBrowserOffline(): void {
  emit();
}

/**
 * Records a request that failed before any response arrived. The client calls
 * it on every `ApiNetworkError`; a fetcher that calls `fetch` itself can call
 * it on a network `TypeError`.
 */
export function reportNetworkFailure(): void {
  networkDown = true;
  emit();
}

/**
 * Records a response of any status, which proves the network is up. The
 * client calls it on every response it receives.
 */
export function reportNetworkSuccess(): void {
  if (!networkDown) {
    return;
  }
  networkDown = false;
  emit();
}

/**
 * Calls `listener` with the new state each time {@link isOnline} changes. The
 * window `online` and `offline` listeners are attached with the first
 * subscriber and removed with the last; outside a browser only request reports
 * move it.
 */
export function subscribeToOnline(
  listener: (online: boolean) => void
): Unsubscribe {
  if (listeners.size === 0) {
    lastReported = isOnline();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', onBrowserOnline);
      window.addEventListener('offline', onBrowserOffline);
    }
  }
  listeners.add(listener);
  return () => {
    if (!listeners.delete(listener)) {
      return;
    }
    if (listeners.size === 0 && typeof window !== 'undefined') {
      window.removeEventListener('online', onBrowserOnline);
      window.removeEventListener('offline', onBrowserOffline);
    }
  };
}
