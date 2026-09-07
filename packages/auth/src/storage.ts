/**
 * Token storage.
 *
 * The two applications disagree on the key: CarModPicker uses `access_token`,
 * Portfolio uses `authToken`. Neither is more correct, so the key is a
 * constructor argument and each application keeps its own during migration
 * rather than silently signing every user out on the deploy that adopts this
 * package.
 */

/** Minimal storage contract. `localStorage` satisfies it. */
export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * In memory storage. The default when no Storage is available, which covers
 * server side rendering, tests, and a browser with site data blocked, where
 * touching `localStorage` throws rather than returning null.
 */
export class MemoryTokenStorage implements TokenStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

/**
 * Returns `localStorage` when it is usable, an in memory store otherwise.
 *
 * The probe is a real write. Safari in private mode, and any browser set to
 * block site data, exposes a `localStorage` object whose `setItem` throws, so
 * a presence check alone is not enough.
 */
export function defaultTokenStorage(): TokenStorage {
  try {
    const probeKey = '__webbpulse_probe__';
    globalThis.localStorage.setItem(probeKey, '1');
    globalThis.localStorage.removeItem(probeKey);
    return globalThis.localStorage;
  } catch {
    return new MemoryTokenStorage();
  }
}

/** Reads and writes one token under one key. */
export class TokenStore {
  private readonly key: string;
  private readonly storage: TokenStorage;

  constructor(key: string, storage: TokenStorage = defaultTokenStorage()) {
    this.key = key;
    this.storage = storage;
  }

  get(): string | null {
    try {
      return this.storage.getItem(this.key);
    } catch {
      return null;
    }
  }

  set(token: string): void {
    try {
      this.storage.setItem(this.key, token);
    } catch {
      // A browser that refuses the write leaves the session in memory only.
      // Failing the login over it would be worse than a shorter session.
    }
  }

  clear(): void {
    try {
      this.storage.removeItem(this.key);
    } catch {
      // Nothing useful to do; the token was already unreachable.
    }
  }
}
