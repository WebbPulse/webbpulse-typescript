/**
 * Page level user activity, shared by every polled query so a page holding
 * many of them attaches one set of listeners rather than one per query.
 * Framework free: it needs a `window` and nothing else, and outside a browser
 * it reports the person as always active.
 */

import type { Unsubscribe } from './refetch-registry.js';

/** The window events that count as the person being present. */
export const ACTIVITY_EVENTS: readonly string[] = [
  'pointerdown',
  'pointermove',
  'keydown',
  'wheel',
  'touchstart',
  'focus',
];

const listeners = new Set<() => void>();
let lastActivity = Date.now();

/** Records activity and tells every subscriber. */
function markActive(): void {
  lastActivity = Date.now();
  for (const listener of [...listeners]) {
    listener();
  }
}

/** Counts a return to a visible document as activity. */
function onVisibility(): void {
  if (document.visibilityState !== 'hidden') {
    markActive();
  }
}

const LISTENER_OPTIONS: AddEventListenerOptions = {
  capture: true,
  passive: true,
};

/** Attaches the page listeners and starts the clock from now. */
function attach(): void {
  lastActivity = Date.now();
  for (const name of ACTIVITY_EVENTS) {
    window.addEventListener(name, markActive, LISTENER_OPTIONS);
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }
}

/** Removes the page listeners. */
function detach(): void {
  for (const name of ACTIVITY_EVENTS) {
    window.removeEventListener(name, markActive, LISTENER_OPTIONS);
  }
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibility);
  }
}

/**
 * Calls `listener` on every pointer, key, wheel, touch or focus event on the
 * page and on each return to a visible document. The page listeners are
 * attached with the first subscriber, which also restarts the idle clock, and
 * removed with the last. Outside a browser it subscribes nothing.
 */
export function subscribeToActivity(listener: () => void): Unsubscribe {
  if (typeof window === 'undefined') {
    return () => undefined;
  }
  if (listeners.size === 0) {
    attach();
  }
  listeners.add(listener);
  return () => {
    if (!listeners.delete(listener)) {
      return;
    }
    if (listeners.size === 0) {
      detach();
    }
  };
}

/**
 * Milliseconds since the last activity event, or 0 outside a browser, where
 * nobody can be idle.
 */
export function idleForMs(): number {
  if (typeof window === 'undefined') {
    return 0;
  }
  return Math.max(0, Date.now() - lastActivity);
}
