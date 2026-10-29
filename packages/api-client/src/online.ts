/**
 * Whether the app can reach its API, shared by every client and hook. Combines
 * the browser's `navigator.onLine` with what requests report. A fetch that
 * fails at the network layer starts a spell of trouble: the API is probed at
 * once and again with exponential backoff, and the app reads offline only when
 * the trouble outlasts a grace period, or at once when the browser itself
 * reports offline. Any response or successful probe ends the trouble. Framework
 * free, and outside a browser it starts online and moves only on what requests
 * and probes report.
 */

import type { Unsubscribe } from './refetch-registry.js';

/** How long trouble must last before the app reads offline, by default. */
export const DEFAULT_OFFLINE_GRACE_MS = 15_000;

/** The wait before the second probe by default, doubled after each failure. */
export const DEFAULT_PROBE_BASE_MS = 1_000;

/** The longest wait between probes by default. */
export const DEFAULT_PROBE_MAX_MS = 30_000;

/**
 * One reachability check. Resolving with anything proves the network is up;
 * rejecting means it is still in doubt.
 */
export type ReachabilityProbe = () => Promise<unknown>;

/** Tuning for the shared reachability signal. */
export interface ReachabilityOptions {
  /**
   * How long a network failure must go unanswered before the app reads
   * offline. Defaults to {@link DEFAULT_OFFLINE_GRACE_MS}. 0 reads offline on
   * the first failure, as before 0.23.
   */
  graceMs?: number;
  /** The wait before the second probe. Defaults to {@link DEFAULT_PROBE_BASE_MS}. */
  probeBaseMs?: number;
  /** The cap on the wait between probes. Defaults to {@link DEFAULT_PROBE_MAX_MS}. */
  probeMaxMs?: number;
  /**
   * Whether to probe while there is trouble. Defaults to true. With false the
   * trouble ends only on a response or a browser `online` event.
   */
  probe?: boolean;
}

interface ReachabilityConfig {
  graceMs: number;
  probeBaseMs: number;
  probeMaxMs: number;
  probe: boolean;
}

const DEFAULT_CONFIG: ReachabilityConfig = {
  graceMs: DEFAULT_OFFLINE_GRACE_MS,
  probeBaseMs: DEFAULT_PROBE_BASE_MS,
  probeMaxMs: DEFAULT_PROBE_MAX_MS,
  probe: true,
};

const listeners = new Set<(online: boolean) => void>();
const recoveryListeners = new Set<() => void>();
let config: ReachabilityConfig = { ...DEFAULT_CONFIG };
let troubled = false;
let networkDown = false;
let lastReported: boolean | undefined;
let probeImpl: ReachabilityProbe | undefined;
let probing = false;
let attempts = 0;
let graceTimer: ReturnType<typeof setTimeout> | undefined;
let probeTimer: ReturnType<typeof setTimeout> | undefined;
let windowListening = false;
let returnListening = false;

/** What the browser says, or true where there is no `navigator.onLine`. */
function browserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/**
 * Sets the grace period, probe backoff and whether to probe at all. Options
 * left out return to their defaults, so `configureReachability()` resets.
 */
export function configureReachability(options: ReachabilityOptions = {}): void {
  config = {
    graceMs: options.graceMs ?? DEFAULT_CONFIG.graceMs,
    probeBaseMs: options.probeBaseMs ?? DEFAULT_CONFIG.probeBaseMs,
    probeMaxMs: options.probeMaxMs ?? DEFAULT_CONFIG.probeMaxMs,
    probe: options.probe ?? DEFAULT_CONFIG.probe,
  };
  if (!config.probe) {
    clearProbeTimer();
  }
}

/**
 * Whether the app is online: the browser reports a connection and no network
 * failure has gone unanswered for longer than the grace period.
 */
export function isOnline(): boolean {
  return browserOnline() && !networkDown;
}

/** Tells every subscriber when the combined state has changed. */
function emit(): void {
  if (listeners.size === 0) {
    return;
  }
  const online = isOnline();
  if (online === lastReported) {
    return;
  }
  lastReported = online;
  for (const listener of [...listeners]) {
    listener(online);
  }
}

function clearGraceTimer(): void {
  if (graceTimer !== undefined) {
    clearTimeout(graceTimer);
    graceTimer = undefined;
  }
}

function clearProbeTimer(): void {
  if (probeTimer !== undefined) {
    clearTimeout(probeTimer);
    probeTimer = undefined;
  }
}

/** Whether a probe can run now. */
function canProbe(): boolean {
  return config.probe && probeImpl !== undefined;
}

/** Marks the trouble as a confirmed outage. */
function confirmDown(): void {
  clearGraceTimer();
  if (!troubled || networkDown) {
    return;
  }
  networkDown = true;
  emit();
}

/** Runs one probe and schedules the next while the trouble lasts. */
async function runProbe(): Promise<void> {
  const probe = probeImpl;
  if (probing || !troubled || !config.probe || probe === undefined) {
    return;
  }
  if (!browserOnline()) {
    return;
  }
  probing = true;
  let reached: boolean;
  try {
    await probe();
    reached = true;
  } catch {
    reached = false;
  } finally {
    probing = false;
  }
  if (reached) {
    reportNetworkSuccess();
    return;
  }
  if (!troubled || probeTimer !== undefined || !config.probe) {
    return;
  }
  const wait = Math.min(config.probeMaxMs, config.probeBaseMs * 2 ** attempts);
  attempts += 1;
  probeTimer = setTimeout(() => {
    probeTimer = undefined;
    void runProbe();
  }, wait);
}

/**
 * Probes at once, dropping any backoff, while a network failure is still
 * unanswered. Does nothing otherwise. The signal calls it on window focus,
 * on the document becoming visible and on a browser `online` event.
 */
export function probeReachabilityNow(): void {
  if (!troubled || !canProbe()) {
    return;
  }
  clearProbeTimer();
  attempts = 0;
  void runProbe();
}

/** Re-probes when the person comes back to a visible tab. */
function onReturn(): void {
  if (typeof document !== 'undefined' && document.hidden) {
    return;
  }
  probeReachabilityNow();
}

/** Probes on a browser `online` event, or trusts it when nothing can probe. */
function onBrowserOnline(): void {
  if (troubled) {
    if (canProbe()) {
      probeReachabilityNow();
    } else {
      reportNetworkSuccess();
      return;
    }
  }
  emit();
}

/** Trusts a browser `offline` event at once, skipping the grace period. */
function onBrowserOffline(): void {
  if (troubled) {
    confirmDown();
  }
  emit();
}

/**
 * Keeps the window and document listeners in step with what needs them:
 * `online` and `offline` while anything subscribes or there is trouble, focus
 * and visibility only while there is trouble.
 */
function syncListeners(): void {
  const wantWindow = listeners.size > 0 || troubled;
  if (typeof window !== 'undefined' && wantWindow !== windowListening) {
    if (wantWindow) {
      window.addEventListener('online', onBrowserOnline);
      window.addEventListener('offline', onBrowserOffline);
    } else {
      window.removeEventListener('online', onBrowserOnline);
      window.removeEventListener('offline', onBrowserOffline);
    }
    windowListening = wantWindow;
  }
  if (troubled !== returnListening) {
    if (typeof window !== 'undefined') {
      if (troubled) {
        window.addEventListener('focus', onReturn);
      } else {
        window.removeEventListener('focus', onReturn);
      }
    }
    if (typeof document !== 'undefined') {
      if (troubled) {
        document.addEventListener('visibilitychange', onReturn);
      } else {
        document.removeEventListener('visibilitychange', onReturn);
      }
    }
    returnListening = troubled;
  }
}

/**
 * Records a request that failed before any response arrived. The client calls
 * it on every `ApiNetworkError` with a probe of its own; a fetcher that calls
 * `fetch` itself can call it on a network `TypeError`, with or without a probe.
 * The first failure of a spell starts the grace period and probes at once.
 */
export function reportNetworkFailure(probe?: ReachabilityProbe): void {
  if (probe !== undefined) {
    probeImpl = probe;
  }
  if (troubled) {
    if (!browserOnline()) {
      confirmDown();
    }
    return;
  }
  troubled = true;
  attempts = 0;
  syncListeners();
  if (config.graceMs <= 0 || !browserOnline()) {
    confirmDown();
  } else {
    graceTimer = setTimeout(confirmDown, config.graceMs);
  }
  void runProbe();
}

/**
 * Records a response of any status, which proves the network is up and ends
 * any trouble. The client calls it on every response it receives.
 */
export function reportNetworkSuccess(): void {
  if (!troubled && !networkDown) {
    return;
  }
  troubled = false;
  networkDown = false;
  attempts = 0;
  clearGraceTimer();
  clearProbeTimer();
  syncListeners();
  emit();
  for (const listener of [...recoveryListeners]) {
    listener();
  }
}

/**
 * Calls `listener` with the new state each time {@link isOnline} changes. The
 * window `online` and `offline` listeners are attached with the first
 * subscriber and removed with the last; outside a browser only request reports
 * and probes move it.
 */
export function subscribeToOnline(
  listener: (online: boolean) => void
): Unsubscribe {
  if (listeners.size === 0) {
    lastReported = isOnline();
  }
  listeners.add(listener);
  syncListeners();
  return () => {
    if (!listeners.delete(listener)) {
      return;
    }
    syncListeners();
  };
}

/**
 * Calls `listener` each time a spell of network trouble ends, whether or not
 * it lasted long enough to read offline. The auth client retries a refresh
 * held through an outage on it.
 */
export function subscribeToNetworkRecovery(listener: () => void): Unsubscribe {
  recoveryListeners.add(listener);
  return () => {
    recoveryListeners.delete(listener);
  };
}
