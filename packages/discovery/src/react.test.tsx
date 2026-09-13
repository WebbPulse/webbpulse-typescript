import { render, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAvailabilityCache } from './availability.js';
import { OAUTH_PROVIDERS_PATH, type OAuthProviderInfo } from './oauth.js';
import { useOAuthProviders, type OAuthProvidersOptions } from './react.js';

const ORIGIN = 'https://api.example.test';
const PROVIDERS_URL = `${ORIGIN}${OAUTH_PROVIDERS_PATH}`;

const GOOGLE_WIRE = { id: 'google', display_name: 'Google' };
const GITHUB_WIRE = { id: 'github', display_name: 'GitHub' };
const GOOGLE: OAuthProviderInfo = { id: 'google', displayName: 'Google' };
const GITHUB: OAuthProviderInfo = { id: 'github', displayName: 'GitHub' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch stub resolving one JSON body for every call. */
function answering(body: unknown, status = 200): typeof fetch {
  return vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(body, status)));
}

/** A fetch stub that rejects, standing in for a dropped request. */
function failing(): typeof fetch {
  return vi.fn<typeof fetch>(() => Promise.reject(new TypeError('failed')));
}

/** Renders the provider list as JSON, so assertions read one node off the DOM. */
function Probe(
  options: OAuthProvidersOptions & { testId?: string }
): React.ReactNode {
  const { testId = 'providers', ...rest } = options;
  const providers = useOAuthProviders(rest);
  return <span data-testid={testId}>{JSON.stringify(providers)}</span>;
}

function mount(
  options: OAuthProvidersOptions,
  strict = false
): ReturnType<typeof render> {
  const element = <Probe {...options} />;
  return render(strict ? <StrictMode>{element}</StrictMode> : element);
}

/** Reads a probe's provider list back off the DOM. */
function providersOf(container: HTMLElement, testId = 'providers') {
  const text =
    container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? 'null';
  return JSON.parse(text) as OAuthProviderInfo[];
}

beforeEach(() => {
  resetAvailabilityCache();
});

afterEach(() => {
  resetAvailabilityCache();
  vi.restoreAllMocks();
});

describe('useOAuthProviders', () => {
  it('starts empty, before the round trip has answered', () => {
    const fetchImpl = answering({ providers: [GOOGLE_WIRE] });

    const { container } = mount({ identityOrigin: ORIGIN, fetchImpl });

    expect(providersOf(container)).toEqual([]);
  });

  it('fills in the configured providers after the round trip', async () => {
    const fetchImpl = answering({ providers: [GOOGLE_WIRE] });

    const { container } = mount({ identityOrigin: ORIGIN, fetchImpl });

    await waitFor(() => {
      expect(providersOf(container)).toEqual([GOOGLE]);
    });
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe(PROVIDERS_URL);
  });

  it('keeps the order the deployment listed', async () => {
    const fetchImpl = answering({ providers: [GITHUB_WIRE, GOOGLE_WIRE] });

    const { container } = mount({ identityOrigin: ORIGIN, fetchImpl });

    await waitFor(() => {
      expect(providersOf(container)).toEqual([GITHUB, GOOGLE]);
    });
  });

  it('reads a path the browser resolves when the origin is empty', async () => {
    const fetchImpl = answering({ providers: [GOOGLE_WIRE] });

    const { container } = mount({ identityOrigin: '', fetchImpl });

    await waitFor(() => {
      expect(providersOf(container)).toEqual([GOOGLE]);
    });
    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe(OAUTH_PROVIDERS_PATH);
  });

  it('does not read when disabled', async () => {
    const fetchImpl = answering({ providers: [GOOGLE_WIRE] });

    const { container } = mount({
      identityOrigin: ORIGIN,
      enabled: false,
      fetchImpl,
    });

    await waitFor(() => {
      expect(providersOf(container)).toEqual([]);
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reads once enabled turns on', async () => {
    const fetchImpl = answering({ providers: [GOOGLE_WIRE] });

    const { container, rerender } = render(
      <Probe identityOrigin={ORIGIN} enabled={false} fetchImpl={fetchImpl} />
    );
    expect(fetchImpl).not.toHaveBeenCalled();

    rerender(<Probe identityOrigin={ORIGIN} enabled fetchImpl={fetchImpl} />);

    await waitFor(() => {
      expect(providersOf(container)).toEqual([GOOGLE]);
    });
  });

  it('shares one read between two hooks on the same page', async () => {
    const fetchImpl = answering({ providers: [GOOGLE_WIRE, GITHUB_WIRE] });

    const { container } = render(
      <div>
        <Probe identityOrigin={ORIGIN} fetchImpl={fetchImpl} testId="first" />
        <Probe identityOrigin={ORIGIN} fetchImpl={fetchImpl} testId="second" />
      </div>
    );

    await waitFor(() => {
      expect(providersOf(container, 'first')).toEqual([GOOGLE, GITHUB]);
    });
    expect(providersOf(container, 'second')).toEqual([GOOGLE, GITHUB]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('draws nothing when the read failed', async () => {
    const fetchImpl = failing();

    const { container } = mount({ identityOrigin: ORIGIN, fetchImpl });

    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    expect(providersOf(container)).toEqual([]);
  });

  it('draws nothing for a backend that predates the route', async () => {
    const fetchImpl = answering({}, 404);

    const { container } = mount({ identityOrigin: ORIGIN, fetchImpl });

    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    expect(providersOf(container)).toEqual([]);
  });

  it('draws nothing for a deployment with none configured', async () => {
    const fetchImpl = answering({ providers: [] });

    const { container } = mount({ identityOrigin: ORIGIN, fetchImpl });

    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    expect(providersOf(container)).toEqual([]);
  });

  it('sets no state after unmounting mid read', async () => {
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let release: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn<typeof fetch>(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );

    const { unmount } = mount({ identityOrigin: ORIGIN, fetchImpl });
    await waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
    unmount();
    release?.(jsonResponse({ providers: [GOOGLE_WIRE] }));
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).not.toHaveBeenCalled();
  });

  it('reads once under StrictMode, which mounts effects twice', async () => {
    const fetchImpl = answering({ providers: [GOOGLE_WIRE] });

    const { container } = mount({ identityOrigin: ORIGIN, fetchImpl }, true);

    await waitFor(() => {
      expect(providersOf(container)).toEqual([GOOGLE]);
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
