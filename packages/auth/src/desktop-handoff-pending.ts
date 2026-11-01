/**
 * What a handoff has to remember while the person is away in a browser. The app
 * side holds its PKCE verifier until the callback arrives; the browser side holds
 * the handoff page's request across a mailed link, which drops any `returnTo`.
 * Each entry expires, and a value that cannot be read counts as nothing held.
 */

import { DESKTOP_HANDOFF_PAGE_PATH } from './desktop-handoff.js';

/** How long a browser sign-in may take before its verifier is discarded. */
export const DESKTOP_HANDOFF_VERIFIER_TTL_MS = 10 * 60 * 1000;

/** How long the way back to the app is offered: long enough to read a mailed link. */
export const DESKTOP_HANDOFF_RETURN_TTL_MS = 60 * 60 * 1000;

type ValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

interface HeldValue {
  value: string;
  savedAt: number;
}

/** Local storage, or null where it is absent or reading the property throws. */
function deviceStorage(): Storage | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/** A single slot with the storage interface, which lasts as long as the process. */
function memorySlot(): ValueStorage {
  let held: string | null = null;
  return {
    getItem: () => held,
    setItem: (_key, value) => {
      held = value;
    },
    removeItem: () => {
      held = null;
    },
  };
}

/** Writes a value with its time, leaving nothing new where storage refuses. */
function writeHeld(
  storage: ValueStorage | null,
  key: string,
  value: string,
  now: number
): void {
  const held: HeldValue = { value, savedAt: now };
  try {
    storage?.setItem(key, JSON.stringify(held));
  } catch {
    return;
  }
}

/** The value in a stored entry, or null when it is unreadable or past its time. */
function liveValue(
  raw: string | null,
  ttlMs: number,
  now: number
): string | null {
  if (raw === null) {
    return null;
  }
  try {
    const held = JSON.parse(raw) as Partial<HeldValue>;
    if (typeof held.value !== 'string' || typeof held.savedAt !== 'number') {
      return null;
    }
    return now - held.savedAt <= ttlMs ? held.value : null;
  } catch {
    return null;
  }
}

/** Options for {@link createDesktopHandoffVerifierStore}. */
export interface DesktopHandoffVerifierStoreOptions {
  /**
   * The local storage key, for a shell the operating system can stop while the
   * browser is open, such as a mobile app. Omit it to hold the verifier in memory,
   * which is also where it stays when local storage is unavailable.
   */
  storageKey?: string;
  /** Defaults to {@link DESKTOP_HANDOFF_VERIFIER_TTL_MS}. */
  ttlMs?: number;
}

/** The verifier of the one browser sign-in in flight. */
export interface DesktopHandoffVerifierStore {
  /** Keeps a verifier as the one pending sign-in, replacing any earlier one. */
  keep: (verifier: string, now?: number) => void;
  /** Spends the verifier: answers it once, or null when none is held or it expired. */
  take: (now?: number) => string | null;
  /**
   * Whether one is held, without spending it. An expired one counts, so the
   * caller that goes on to take it can report the expiry.
   */
  hasPending: () => boolean;
}

/** A single-use, expiring holder for the app side's PKCE verifier. */
export function createDesktopHandoffVerifierStore(
  options: DesktopHandoffVerifierStoreOptions = {}
): DesktopHandoffVerifierStore {
  const { storageKey, ttlMs = DESKTOP_HANDOFF_VERIFIER_TTL_MS } = options;
  const key = storageKey ?? 'desktop-handoff-verifier';
  const memory = memorySlot();
  const storage = (): ValueStorage =>
    storageKey === undefined ? memory : (deviceStorage() ?? memory);

  return {
    keep: (verifier, now = Date.now()) => {
      writeHeld(storage(), key, verifier, now);
    },
    take: (now = Date.now()) => {
      const held = storage();
      let raw: string | null;
      try {
        raw = held.getItem(key);
        held.removeItem(key);
      } catch {
        return null;
      }
      return liveValue(raw, ttlMs, now);
    },
    hasPending: () => {
      try {
        return storage().getItem(key) !== null;
      } catch {
        return false;
      }
    },
  };
}

/** Options for {@link createDesktopHandoffReturnStore}. */
export interface DesktopHandoffReturnStoreOptions {
  /** The local storage key. */
  storageKey: string;
  /** Defaults to {@link DESKTOP_HANDOFF_RETURN_TTL_MS}. */
  ttlMs?: number;
  /** The handoff page. Defaults to {@link DESKTOP_HANDOFF_PAGE_PATH}. */
  pagePath?: string;
}

/** The handoff page request to go back to, kept in the browser. */
export interface DesktopHandoffReturnStore {
  /** Keeps the handoff page's path and query as the way back to the app. */
  remember: (path: string, now?: number) => void;
  /**
   * The path to go back to, or null when none is kept, it expired, or it is not a
   * path on the handoff page, since it becomes a link.
   */
  read: (now?: number) => string | null;
  /** Forgets the way back. */
  clear: () => void;
}

/**
 * Keeps the handoff page's request for when a sign-up, password reset or email
 * verification comes back through a mailed link. It holds only the path with the
 * app's public challenge, never a code or a verifier, and a stale challenge just
 * fails in the app. Without local storage, nothing is kept.
 */
export function createDesktopHandoffReturnStore(
  options: DesktopHandoffReturnStoreOptions
): DesktopHandoffReturnStore {
  const {
    storageKey,
    ttlMs = DESKTOP_HANDOFF_RETURN_TTL_MS,
    pagePath = DESKTOP_HANDOFF_PAGE_PATH,
  } = options;

  return {
    remember: (path, now = Date.now()) => {
      writeHeld(deviceStorage(), storageKey, path, now);
    },
    read: (now = Date.now()) => {
      let raw: string | null;
      try {
        raw = deviceStorage()?.getItem(storageKey) ?? null;
      } catch {
        return null;
      }
      const path = liveValue(raw, ttlMs, now);
      return path !== null && path.startsWith(`${pagePath}?`) ? path : null;
    },
    clear: () => {
      try {
        deviceStorage()?.removeItem(storageKey);
      } catch {
        return;
      }
    },
  };
}
