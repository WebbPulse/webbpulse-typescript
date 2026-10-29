import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';

import { createApiClient } from './client.js';
import {
  configureReachability,
  DEFAULT_OFFLINE_GRACE_MS,
  isOnline,
  probeReachabilityNow,
  reportNetworkFailure,
  reportNetworkSuccess,
  subscribeToNetworkRecovery,
  subscribeToOnline,
} from './online.js';

/** A probe that fails until `answer` is called. */
function controllableProbe(): {
  probe: Mock<() => Promise<unknown>>;
  answer: () => void;
} {
  let up = false;
  const probe = vi.fn<() => Promise<unknown>>(() =>
    up ? Promise.resolve('ok') : Promise.reject(new TypeError('down'))
  );
  return {
    probe,
    answer: () => {
      up = true;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  configureReachability();
});

afterEach(() => {
  reportNetworkSuccess();
  configureReachability();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('reachability grace period', () => {
  it('stays online through a blip the first probe disproves', async () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeToOnline((online) => seen.push(online));
    const probe = vi.fn(() => Promise.resolve('ok'));

    reportNetworkFailure(probe);
    expect(isOnline()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);

    expect(probe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_OFFLINE_GRACE_MS * 2);
    expect(isOnline()).toBe(true);
    expect(seen).toEqual([]);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    unsubscribe();
  });

  it('reads offline only once the trouble outlasts the grace period', async () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeToOnline((online) => seen.push(online));
    const { probe } = controllableProbe();

    reportNetworkFailure(probe);
    await vi.advanceTimersByTimeAsync(DEFAULT_OFFLINE_GRACE_MS - 1);
    expect(isOnline()).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(isOnline()).toBe(false);
    expect(seen).toEqual([false]);

    unsubscribe();
  });

  it('honours a configured grace period', async () => {
    configureReachability({ graceMs: 5_000, probe: false });

    reportNetworkFailure();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(isOnline()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(isOnline()).toBe(false);
  });

  it('reads offline at once with a grace period of 0', () => {
    configureReachability({ graceMs: 0, probe: false });

    reportNetworkFailure();

    expect(isOnline()).toBe(false);
  });

  it('reads offline at once when the browser reports offline', () => {
    vi.stubGlobal('navigator', { onLine: false });
    const probe = vi.fn(() => Promise.resolve('ok'));

    reportNetworkFailure(probe);

    expect(isOnline()).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });

  it('comes back online and notifies recovery when a probe answers', async () => {
    const seen: boolean[] = [];
    const unsubscribe = subscribeToOnline((online) => seen.push(online));
    const recovered = vi.fn();
    const stopRecovery = subscribeToNetworkRecovery(recovered);
    const { probe, answer } = controllableProbe();

    reportNetworkFailure(probe);
    await vi.advanceTimersByTimeAsync(DEFAULT_OFFLINE_GRACE_MS);
    expect(isOnline()).toBe(false);

    answer();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(isOnline()).toBe(true);
    expect(seen).toEqual([false, true]);
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);

    stopRecovery();
    unsubscribe();
  });

  it('clears its timers when a response ends the trouble', () => {
    const { probe } = controllableProbe();

    reportNetworkFailure(probe);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    reportNetworkSuccess();

    expect(vi.getTimerCount()).toBe(0);
    expect(isOnline()).toBe(true);
  });
});

describe('reachability probe backoff', () => {
  it('probes at once, then after 1s, 2s and 4s, capped at 30s', async () => {
    const { probe } = controllableProbe();

    reportNetworkFailure(probe);
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(1);

    const gaps = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const [index, gap] of gaps.entries()) {
      await vi.advanceTimersByTimeAsync(gap - 1);
      expect(probe).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(probe).toHaveBeenCalledTimes(index + 2);
    }
  });

  it('honours a configured backoff', async () => {
    configureReachability({ probeBaseMs: 100, probeMaxMs: 300 });
    const { probe } = controllableProbe();

    reportNetworkFailure(probe);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    expect(probe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(probe).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(300);
    expect(probe).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(300);
    expect(probe).toHaveBeenCalledTimes(5);
  });

  it('starts one spell for repeated failures', async () => {
    const { probe } = controllableProbe();

    reportNetworkFailure(probe);
    reportNetworkFailure(probe);
    reportNetworkFailure(probe);
    await vi.advanceTimersByTimeAsync(0);

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('drops the backoff on probeReachabilityNow', async () => {
    const { probe } = controllableProbe();

    reportNetworkFailure(probe);
    await vi.advanceTimersByTimeAsync(7_500);
    expect(probe).toHaveBeenCalledTimes(4);

    probeReachabilityNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(probe).toHaveBeenCalledTimes(6);
  });

  it('does not probe when probing is off', async () => {
    configureReachability({ probe: false });
    const probe = vi.fn(() => Promise.resolve('ok'));

    reportNetworkFailure(probe);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(probe).not.toHaveBeenCalled();
    expect(isOnline()).toBe(false);
  });

  it('does nothing on probeReachabilityNow without trouble', async () => {
    const probe = vi.fn(() => Promise.resolve('ok'));
    reportNetworkFailure(probe);
    await vi.advanceTimersByTimeAsync(0);
    probe.mockClear();

    probeReachabilityNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(probe).not.toHaveBeenCalled();
  });
});

describe('reachability window events', () => {
  /** Stubs a window and document that record their listeners. */
  function stubBrowser(): { win: EventTarget; doc: EventTarget } {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal('window', win);
    vi.stubGlobal('document', doc);
    return { win, doc };
  }

  it('re-probes on focus and visibility while there is trouble', async () => {
    const { win, doc } = stubBrowser();
    const { probe } = controllableProbe();

    reportNetworkFailure(probe);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(probe).toHaveBeenCalledTimes(3);

    win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(500);
    doc.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(0);
    expect(probe).toHaveBeenCalledTimes(5);
  });

  it('re-probes on the browser online event', async () => {
    const { win } = stubBrowser();
    const { probe, answer } = controllableProbe();

    reportNetworkFailure(probe);
    await vi.advanceTimersByTimeAsync(DEFAULT_OFFLINE_GRACE_MS);
    expect(isOnline()).toBe(false);

    answer();
    win.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(0);

    expect(isOnline()).toBe(true);
  });

  it('stops listening once the trouble ends', async () => {
    const { win } = stubBrowser();
    const { probe } = controllableProbe();

    reportNetworkFailure(probe);
    await vi.advanceTimersByTimeAsync(0);
    reportNetworkSuccess();
    probe.mockClear();

    win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(probe).not.toHaveBeenCalled();
  });
});

describe('client probe', () => {
  it('probes the configured path after a network failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>((url) =>
      String(url).endsWith('/health')
        ? Promise.resolve(new Response(null, { status: 404 }))
        : Promise.reject(new TypeError('Failed to fetch'))
    );
    const client = createApiClient({
      baseUrl: 'https://api.test',
      retries: 0,
      fetch: fetchImpl,
      probePath: '/health',
    });
    const recovered = vi.fn();
    const stopRecovery = subscribeToNetworkRecovery(recovered);

    await expect(client.get('/x')).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe(
      'https://api.test/health'
    );
    expect(fetchImpl.mock.calls[1]?.[1]).toMatchObject({
      method: 'GET',
      credentials: 'omit',
    });
    expect(recovered).toHaveBeenCalledTimes(1);
    expect(isOnline()).toBe(true);

    stopRecovery();
  });

  it('probes the base URL by default', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.reject(new TypeError('Failed to fetch'))
    );
    const client = createApiClient({
      baseUrl: 'https://api.test',
      retries: 0,
      fetch: fetchImpl,
    });

    await expect(client.get('/x')).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);

    expect(String(fetchImpl.mock.calls[1]?.[0])).toBe('https://api.test/');
  });

  it('does not probe with a null probePath', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.reject(new TypeError('Failed to fetch'))
    );
    const client = createApiClient({
      baseUrl: 'https://api.test',
      retries: 0,
      fetch: fetchImpl,
      probePath: null,
    });

    await expect(client.get('/x')).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
