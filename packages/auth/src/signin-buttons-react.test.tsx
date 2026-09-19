import { render, renderHook, waitFor } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  useOAuthProviderLinks,
  usePasskeySignInButton,
  type OAuthProviderLinksOptions,
  type PasskeySignInButtonOptions,
} from './react.js';
import type { PasskeySignInOutcome } from './passkeys.js';

type Availability = 'available' | 'unavailable' | 'unknown';

/** Puts a WebAuthn capable `PublicKeyCredential` on the global. */
function browserWithPasskeys(conditional = false): void {
  vi.stubGlobal('PublicKeyCredential', {
    isConditionalMediationAvailable: vi.fn(() => Promise.resolve(conditional)),
  });
}

/** Removes `PublicKeyCredential`, which is how a browser without WebAuthn reads. */
function browserWithoutPasskeys(): void {
  vi.stubGlobal('PublicKeyCredential', undefined);
}

/** A probe resolving the given answer. */
function probeAnswering(availability: Availability) {
  return vi.fn<() => Promise<Availability>>(() =>
    Promise.resolve(availability)
  );
}

/** A signed-in outcome, the ordinary success. */
const SIGNED_IN: PasskeySignInOutcome = {
  ok: true,
  kind: 'signed-in',
} as PasskeySignInOutcome;

/** A client whose `signInWithPasskey` resolves whatever the test hands it. */
function clientResolving(outcome: PasskeySignInOutcome) {
  return {
    signInWithPasskey: vi.fn(() => Promise.resolve(outcome)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Renders the button state as text, so assertions read off the DOM. */
function PasskeyProbe(options: PasskeySignInButtonOptions): React.ReactNode {
  const button = usePasskeySignInButton(options);
  return (
    <div>
      <span data-testid="offered">{String(button.offered)}</span>
      <span data-testid="busy">{String(button.busy)}</span>
      <span data-testid="conditional">{String(button.conditional)}</span>
      <button type="button" onClick={() => void button.signIn()}>
        sign in
      </button>
    </div>
  );
}

describe('usePasskeySignInButton', () => {
  it('does not offer the button without a client', async () => {
    browserWithPasskeys();
    const probe = probeAnswering('available');

    const { getByTestId } = render(
      <PasskeyProbe client={null} probe={probe} onResult={vi.fn()} />
    );

    await waitFor(() => {
      expect(getByTestId('offered').textContent).toBe('false');
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not offer the button when the browser has no WebAuthn', async () => {
    browserWithoutPasskeys();
    const probe = probeAnswering('available');

    const { getByTestId } = render(
      <PasskeyProbe
        client={clientResolving(SIGNED_IN)}
        probe={probe}
        onResult={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(getByTestId('offered').textContent).toBe('false');
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it('does not offer the button when the deployment says passwordless is off', async () => {
    browserWithPasskeys();

    const { getByTestId } = render(
      <PasskeyProbe
        client={clientResolving(SIGNED_IN)}
        probe={probeAnswering('unavailable')}
        onResult={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(getByTestId('offered').textContent).toBe('false');
    });
  });

  it('offers the button once the deployment says passwordless is on', async () => {
    browserWithPasskeys();

    const { getByTestId } = render(
      <PasskeyProbe
        client={clientResolving(SIGNED_IN)}
        probe={probeAnswering('available')}
        onResult={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(getByTestId('offered').textContent).toBe('true');
    });
  });

  it('reports the outcome of a click-driven ceremony', async () => {
    browserWithPasskeys();
    const client = clientResolving(SIGNED_IN);
    const onResult = vi.fn();

    const { getByTestId, getByRole } = render(
      <PasskeyProbe
        client={client}
        probe={probeAnswering('available')}
        onResult={onResult}
      />
    );
    await waitFor(() => {
      expect(getByTestId('offered').textContent).toBe('true');
    });

    await act(async () => {
      getByRole('button').click();
      await Promise.resolve();
    });

    expect(client.signInWithPasskey).toHaveBeenCalledWith({
      mediation: 'optional',
    });
    expect(onResult).toHaveBeenCalledWith(SIGNED_IN);
  });

  it('passes a trimmed email so a known user skips the chooser', async () => {
    browserWithPasskeys();
    const client = clientResolving(SIGNED_IN);

    const { getByTestId, getByRole } = render(
      <PasskeyProbe
        client={client}
        probe={probeAnswering('available')}
        email="  alice@example.com  "
        onResult={vi.fn()}
      />
    );
    await waitFor(() => {
      expect(getByTestId('offered').textContent).toBe('true');
    });

    await act(async () => {
      getByRole('button').click();
      await Promise.resolve();
    });

    expect(client.signInWithPasskey).toHaveBeenCalledWith({
      email: 'alice@example.com',
      mediation: 'optional',
    });
  });

  it('runs the discoverable flow for a blank email', async () => {
    browserWithPasskeys();
    const client = clientResolving(SIGNED_IN);

    const { getByTestId, getByRole } = render(
      <PasskeyProbe
        client={client}
        probe={probeAnswering('available')}
        email="   "
        onResult={vi.fn()}
      />
    );
    await waitFor(() => {
      expect(getByTestId('offered').textContent).toBe('true');
    });

    await act(async () => {
      getByRole('button').click();
      await Promise.resolve();
    });

    expect(client.signInWithPasskey).toHaveBeenCalledWith({
      mediation: 'optional',
    });
  });

  it('stays silent on a cancellation, which is not a failure to render', async () => {
    browserWithPasskeys();
    const cancelled = {
      ok: false,
      reason: 'cancelled',
      message: 'Cancelled.',
    } as unknown as PasskeySignInOutcome;
    const client = clientResolving(cancelled);
    const onResult = vi.fn();

    const { getByTestId, getByRole } = render(
      <PasskeyProbe
        client={client}
        probe={probeAnswering('available')}
        onResult={onResult}
      />
    );
    await waitFor(() => {
      expect(getByTestId('offered').textContent).toBe('true');
    });

    await act(async () => {
      getByRole('button').click();
      await Promise.resolve();
    });

    expect(onResult).not.toHaveBeenCalled();
  });

  it('reports a refusal that is not a cancellation', async () => {
    browserWithPasskeys();
    const rejected = {
      ok: false,
      reason: 'rejected',
      message: 'That passkey was not recognised.',
    } as unknown as PasskeySignInOutcome;
    const onResult = vi.fn();

    const { getByTestId, getByRole } = render(
      <PasskeyProbe
        client={clientResolving(rejected)}
        probe={probeAnswering('available')}
        onResult={onResult}
      />
    );
    await waitFor(() => {
      expect(getByTestId('offered').textContent).toBe('true');
    });

    await act(async () => {
      getByRole('button').click();
      await Promise.resolve();
    });

    expect(onResult).toHaveBeenCalledWith(rejected);
  });

  it('hands a ceremony that threw to onError and clears busy', async () => {
    browserWithPasskeys();
    const failure = new Error('boom');
    const client = {
      signInWithPasskey: vi.fn(() => Promise.reject(failure)),
    };
    const onError = vi.fn();

    const { getByTestId, getByRole } = render(
      <PasskeyProbe
        client={client as never}
        probe={probeAnswering('available')}
        onResult={vi.fn()}
        onError={onError}
      />
    );
    await waitFor(() => {
      expect(getByTestId('offered').textContent).toBe('true');
    });

    await act(async () => {
      getByRole('button').click();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(getByTestId('busy').textContent).toBe('false');
    });
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it('rejects signIn with the thrown error when no onError is given', async () => {
    browserWithPasskeys();
    const failure = new Error('boom');
    const client = {
      signInWithPasskey: vi.fn(() => Promise.reject(failure)),
    };
    const { result } = renderHook(() =>
      usePasskeySignInButton({
        client,
        probe: probeAnswering('available'),
        onResult: vi.fn(),
        conditional: false,
      })
    );
    await waitFor(() => {
      expect(result.current.offered).toBe(true);
    });

    await expect(result.current.signIn()).rejects.toBe(failure);
    await waitFor(() => {
      expect(result.current.busy).toBe(false);
    });
  });

  it('does not arm conditional mediation when the browser cannot do it', async () => {
    browserWithPasskeys(false);
    const client = clientResolving(SIGNED_IN);

    const { getByTestId } = render(
      <PasskeyProbe
        client={client}
        probe={probeAnswering('available')}
        onResult={vi.fn()}
      />
    );
    await waitFor(() => {
      expect(getByTestId('offered').textContent).toBe('true');
    });

    expect(getByTestId('conditional').textContent).toBe('false');
    expect(client.signInWithPasskey).not.toHaveBeenCalled();
  });

  it('arms a conditional ceremony when the browser can autofill', async () => {
    browserWithPasskeys(true);
    const client = clientResolving(SIGNED_IN);
    const onResult = vi.fn();

    const { getByTestId } = render(
      <PasskeyProbe
        client={client}
        probe={probeAnswering('available')}
        onResult={onResult}
      />
    );

    await waitFor(() => {
      expect(getByTestId('conditional').textContent).toBe('true');
    });
    await waitFor(() => {
      expect(client.signInWithPasskey).toHaveBeenCalledWith(
        expect.objectContaining({ mediation: 'conditional' })
      );
    });
    await waitFor(() => {
      expect(onResult).toHaveBeenCalledWith(SIGNED_IN);
    });
  });

  it('does not arm a conditional ceremony when conditional is false', async () => {
    browserWithPasskeys(true);
    const client = clientResolving(SIGNED_IN);

    const { getByTestId } = render(
      <PasskeyProbe
        client={client}
        probe={probeAnswering('available')}
        onResult={vi.fn()}
        conditional={false}
      />
    );
    await waitFor(() => {
      expect(getByTestId('offered').textContent).toBe('true');
    });

    expect(client.signInWithPasskey).not.toHaveBeenCalled();
  });

  it('aborts the conditional ceremony on unmount', async () => {
    browserWithPasskeys(true);
    let signal: AbortSignal | undefined;
    const client = {
      signInWithPasskey: vi.fn((options: { signal?: AbortSignal }) => {
        signal = options.signal;
        return new Promise<PasskeySignInOutcome>(() => undefined);
      }),
    };

    const { unmount } = render(
      <PasskeyProbe
        client={client as never}
        probe={probeAnswering('available')}
        onResult={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(client.signInWithPasskey).toHaveBeenCalled();
    });
    expect(signal?.aborted).toBe(false);

    unmount();
    expect(signal?.aborted).toBe(true);
  });

  it('drops the result of a conditional ceremony that was torn down', async () => {
    browserWithPasskeys(true);
    let settle: ((outcome: PasskeySignInOutcome) => void) | undefined;
    const client = {
      signInWithPasskey: vi.fn(
        () =>
          new Promise<PasskeySignInOutcome>((resolve) => {
            settle = resolve;
          })
      ),
    };
    const onResult = vi.fn();

    const { unmount } = render(
      <PasskeyProbe
        client={client as never}
        probe={probeAnswering('available')}
        onResult={onResult}
      />
    );
    await waitFor(() => {
      expect(client.signInWithPasskey).toHaveBeenCalled();
    });

    unmount();
    await act(async () => {
      settle?.(SIGNED_IN);
      await Promise.resolve();
    });

    expect(onResult).not.toHaveBeenCalled();
  });

  it('calls the latest handler without restarting the ceremony', async () => {
    browserWithPasskeys(false);
    const client = clientResolving(SIGNED_IN);
    const first = vi.fn();
    const second = vi.fn();
    const probe = probeAnswering('available');

    const { rerender, getByTestId, getByRole } = render(
      <PasskeyProbe client={client} probe={probe} onResult={first} />
    );
    await waitFor(() => {
      expect(getByTestId('offered').textContent).toBe('true');
    });

    rerender(<PasskeyProbe client={client} probe={probe} onResult={second} />);
    await act(async () => {
      getByRole('button').click();
      await Promise.resolve();
    });

    expect(second).toHaveBeenCalledWith(SIGNED_IN);
    expect(first).not.toHaveBeenCalled();
    expect(client.signInWithPasskey).toHaveBeenCalledOnce();
  });
});

/** Renders the provider links as anchors, so assertions read off the DOM. */
function LinksProbe(options: OAuthProviderLinksOptions): React.ReactNode {
  const links = useOAuthProviderLinks(options);
  return (
    <div>
      <span data-testid="count">{String(links.length)}</span>
      {links.map((link) => (
        <a key={link.id} data-testid={link.id} href={link.href}>
          {link.displayName}
        </a>
      ))}
    </div>
  );
}

const PROVIDERS = [
  { id: 'google', displayName: 'Google' },
  { id: 'github', displayName: 'GitHub' },
];

/** A client that builds a start URL the way `AuthClient` does. */
function urlBuildingClient() {
  return {
    oauthStartUrl: vi.fn(
      (provider: string, options: { returnTo?: string }) =>
        `https://api.example.com/api/auth/oauth/${provider}/start${
          options.returnTo === undefined
            ? ''
            : `?return_to=${encodeURIComponent(options.returnTo)}`
        }`
    ),
  };
}

describe('useOAuthProviderLinks', () => {
  it('answers an empty list without a client', () => {
    const { getByTestId } = render(
      <LinksProbe client={null} providers={PROVIDERS} />
    );
    expect(getByTestId('count').textContent).toBe('0');
  });

  it('answers an empty list when the deployment offers no providers', () => {
    const { getByTestId } = render(
      <LinksProbe client={urlBuildingClient()} providers={[]} />
    );
    expect(getByTestId('count').textContent).toBe('0');
  });

  it('builds one link per provider, in the order reported', () => {
    const { getByTestId } = render(
      <LinksProbe client={urlBuildingClient()} providers={PROVIDERS} />
    );

    expect(getByTestId('count').textContent).toBe('2');
    expect(getByTestId('google').getAttribute('href')).toBe(
      'https://api.example.com/api/auth/oauth/google/start'
    );
    expect(getByTestId('github').textContent).toBe('GitHub');
  });

  it('carries returnTo into every start URL', () => {
    const { getByTestId } = render(
      <LinksProbe
        client={urlBuildingClient()}
        providers={PROVIDERS}
        returnTo="/dashboard"
      />
    );

    expect(getByTestId('google').getAttribute('href')).toBe(
      'https://api.example.com/api/auth/oauth/google/start?return_to=%2Fdashboard'
    );
  });

  it('passes an empty options object when returnTo is omitted', () => {
    const client = urlBuildingClient();
    render(<LinksProbe client={client} providers={PROVIDERS} />);

    expect(client.oauthStartUrl).toHaveBeenCalledWith('google', {});
  });

  it('keeps the list referentially stable across a re-render', () => {
    const client = urlBuildingClient();
    const seen: unknown[] = [];

    function Capture(options: OAuthProviderLinksOptions): React.ReactNode {
      seen.push(useOAuthProviderLinks(options));
      return null;
    }

    const { rerender } = render(
      <Capture client={client} providers={PROVIDERS} />
    );
    rerender(<Capture client={client} providers={PROVIDERS} />);

    expect(seen.length).toBe(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it('rebuilds when returnTo changes', () => {
    const client = urlBuildingClient();
    const { getByTestId, rerender } = render(
      <LinksProbe client={client} providers={PROVIDERS} />
    );
    rerender(
      <LinksProbe client={client} providers={PROVIDERS} returnTo="/settings" />
    );

    expect(getByTestId('google').getAttribute('href')).toContain(
      'return_to=%2Fsettings'
    );
  });
});
