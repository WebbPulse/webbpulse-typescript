import { describe, expect, it, vi } from 'vitest';
import {
  MemoryTokenStorage,
  TokenStore,
  defaultTokenStorage,
  type TokenStorage,
} from './storage.js';

/** A storage whose every method throws, as a blocked browser's does. */
function throwingStorage(): TokenStorage {
  return {
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
    removeItem() {
      throw new Error('blocked');
    },
  };
}

describe('MemoryTokenStorage', () => {
  it('round trips a value', () => {
    const storage = new MemoryTokenStorage();
    storage.setItem('k', 'v');
    expect(storage.getItem('k')).toBe('v');
  });

  it('returns null for an unknown key', () => {
    expect(new MemoryTokenStorage().getItem('missing')).toBeNull();
  });

  it('removes a value', () => {
    const storage = new MemoryTokenStorage();
    storage.setItem('k', 'v');
    storage.removeItem('k');
    expect(storage.getItem('k')).toBeNull();
  });
});

describe('TokenStore', () => {
  it('reads and writes through the given storage', () => {
    const store = new TokenStore('access_token', new MemoryTokenStorage());
    expect(store.get()).toBeNull();
    store.set('abc');
    expect(store.get()).toBe('abc');
    store.clear();
    expect(store.get()).toBeNull();
  });

  it('keeps the two applications on separate keys', () => {
    // CarModPicker uses access_token, Portfolio uses authToken. One storage
    // holding both must not let one application read the other's session.
    const storage = new MemoryTokenStorage();
    const carModPicker = new TokenStore('access_token', storage);
    const portfolio = new TokenStore('authToken', storage);

    carModPicker.set('cmp');
    expect(portfolio.get()).toBeNull();

    portfolio.set('pf');
    expect(carModPicker.get()).toBe('cmp');
  });

  it('returns null rather than throwing when the read is blocked', () => {
    expect(new TokenStore('k', throwingStorage()).get()).toBeNull();
  });

  it('swallows a blocked write so login still succeeds', () => {
    const store = new TokenStore('k', throwingStorage());
    expect(() => {
      store.set('token');
    }).not.toThrow();
  });

  it('swallows a blocked clear', () => {
    const store = new TokenStore('k', throwingStorage());
    expect(() => {
      store.clear();
    }).not.toThrow();
  });
});

describe('defaultTokenStorage', () => {
  it('falls back to memory when localStorage throws on write', () => {
    // Safari private mode exposes a localStorage whose setItem throws, so a
    // presence check alone would hand back an unusable object.
    vi.stubGlobal('localStorage', throwingStorage());
    try {
      expect(defaultTokenStorage()).toBeInstanceOf(MemoryTokenStorage);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns localStorage when the probe write succeeds', () => {
    const usable = new MemoryTokenStorage();
    vi.stubGlobal('localStorage', usable);
    try {
      expect(defaultTokenStorage()).toBe(usable);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('leaves no probe key behind', () => {
    const usable = new MemoryTokenStorage();
    vi.stubGlobal('localStorage', usable);
    try {
      defaultTokenStorage();
      expect(usable.getItem('__webbpulse_probe__')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
