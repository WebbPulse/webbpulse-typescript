import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DESKTOP_HANDOFF_RETURN_TTL_MS,
  DESKTOP_HANDOFF_VERIFIER_TTL_MS,
  createDesktopHandoffReturnStore,
  createDesktopHandoffVerifierStore,
} from './desktop-handoff-pending.js';

const KEY = 'exampleapp.handoff';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const PATH = '/desktop-handoff?code_challenge=abc&scheme=exampleapp';

function stubLocalStorage(): Storage {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  } as unknown as Storage;
  vi.stubGlobal('localStorage', storage);
  return storage;
}

function blockLocalStorage(): void {
  vi.stubGlobal('localStorage', undefined);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: () => {
      throw new Error('Site data is blocked.');
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createDesktopHandoffVerifierStore', () => {
  it('holds in memory without a storage key and answers once', () => {
    const storage = stubLocalStorage();
    const setItem = vi.spyOn(storage, 'setItem');
    const store = createDesktopHandoffVerifierStore();

    expect(store.hasPending()).toBe(false);
    store.keep(VERIFIER, 0);
    expect(store.hasPending()).toBe(true);
    expect(setItem).not.toHaveBeenCalled();
    expect(store.take(1)).toBe(VERIFIER);
    expect(store.take(1)).toBeNull();
    expect(store.hasPending()).toBe(false);
  });

  it('survives a restart with a storage key', () => {
    stubLocalStorage();
    createDesktopHandoffVerifierStore({ storageKey: KEY }).keep(VERIFIER, 0);

    const restarted = createDesktopHandoffVerifierStore({ storageKey: KEY });
    expect(restarted.hasPending()).toBe(true);
    expect(restarted.take(1)).toBe(VERIFIER);
    expect(restarted.hasPending()).toBe(false);
  });

  it('replaces an earlier verifier', () => {
    const store = createDesktopHandoffVerifierStore();
    store.keep('first', 0);
    store.keep(VERIFIER, 0);
    expect(store.take(0)).toBe(VERIFIER);
  });

  it('expires after the time limit, spending the verifier either way', () => {
    const store = createDesktopHandoffVerifierStore();
    store.keep(VERIFIER, 0);
    expect(store.take(DESKTOP_HANDOFF_VERIFIER_TTL_MS)).toBe(VERIFIER);

    store.keep(VERIFIER, 0);
    expect(store.hasPending()).toBe(true);
    expect(store.take(DESKTOP_HANDOFF_VERIFIER_TTL_MS + 1)).toBeNull();
    expect(store.hasPending()).toBe(false);
  });

  it('honours a custom time limit', () => {
    const store = createDesktopHandoffVerifierStore({ ttlMs: 10 });
    store.keep(VERIFIER, 0);
    expect(store.take(11)).toBeNull();
  });

  it('spends an unreadable stored value', () => {
    const storage = stubLocalStorage();
    const store = createDesktopHandoffVerifierStore({ storageKey: KEY });

    for (const raw of ['not json', 'null', '{"value":1,"savedAt":0}']) {
      storage.setItem(KEY, raw);
      expect(store.take(0)).toBeNull();
      expect(storage.getItem(KEY)).toBeNull();
    }
  });

  it('falls back to memory where local storage is blocked', () => {
    blockLocalStorage();
    const store = createDesktopHandoffVerifierStore({ storageKey: KEY });
    store.keep(VERIFIER, 0);
    expect(store.take(1)).toBe(VERIFIER);
  });

  it('answers nothing when it cannot spend the stored value', () => {
    const storage = stubLocalStorage();
    const store = createDesktopHandoffVerifierStore({ storageKey: KEY });
    store.keep(VERIFIER, 0);
    vi.spyOn(storage, 'removeItem').mockImplementation(() => {
      throw new Error('Refused.');
    });
    expect(store.take(1)).toBeNull();
  });

  it('swallows a refused write', () => {
    const storage = stubLocalStorage();
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('Quota exceeded.');
    });
    const store = createDesktopHandoffVerifierStore({ storageKey: KEY });
    expect(() => {
      store.keep(VERIFIER, 0);
    }).not.toThrow();
    expect(store.take(0)).toBeNull();
  });
});

describe('createDesktopHandoffReturnStore', () => {
  it('answers the path until it is cleared, without spending it', () => {
    stubLocalStorage();
    const store = createDesktopHandoffReturnStore({ storageKey: KEY });
    store.remember(PATH, 1000);
    expect(store.read(2000)).toBe(PATH);
    expect(store.read(2000)).toBe(PATH);
    store.clear();
    expect(store.read(2000)).toBeNull();
  });

  it('expires after the time limit', () => {
    stubLocalStorage();
    const store = createDesktopHandoffReturnStore({ storageKey: KEY });
    store.remember(PATH, 0);
    expect(store.read(DESKTOP_HANDOFF_RETURN_TTL_MS)).toBe(PATH);
    expect(store.read(DESKTOP_HANDOFF_RETURN_TTL_MS + 1)).toBeNull();
  });

  it('refuses a stored path off the handoff page', () => {
    stubLocalStorage();
    const store = createDesktopHandoffReturnStore({ storageKey: KEY });
    for (const path of [
      '//elsewhere.example/login',
      '/desktop-handoff',
      '/desktop-handoff-other?scheme=exampleapp',
      'https://elsewhere.example/desktop-handoff?scheme=exampleapp',
    ]) {
      store.remember(path, 0);
      expect(store.read(1)).toBeNull();
    }
  });

  it('honours a custom page path', () => {
    stubLocalStorage();
    const store = createDesktopHandoffReturnStore({
      storageKey: KEY,
      pagePath: '/app-sign-in',
    });
    store.remember(PATH, 0);
    expect(store.read(1)).toBeNull();
    store.remember('/app-sign-in?scheme=exampleapp', 0);
    expect(store.read(1)).toBe('/app-sign-in?scheme=exampleapp');
  });

  it('ignores an unreadable stored value', () => {
    const storage = stubLocalStorage();
    storage.setItem(KEY, 'not json');
    expect(
      createDesktopHandoffReturnStore({ storageKey: KEY }).read()
    ).toBeNull();
  });

  it('keeps nothing where local storage is blocked', () => {
    blockLocalStorage();
    const store = createDesktopHandoffReturnStore({ storageKey: KEY });
    expect(() => {
      store.remember(PATH, 0);
      store.clear();
    }).not.toThrow();
    expect(store.read(1)).toBeNull();
  });
});
