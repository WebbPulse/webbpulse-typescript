import { StepUpRequiredError } from '@webbpulse/api-client';
import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import type { AuthClient } from '../auth-client.js';
import type {
  OAuthLink,
  OAuthLinkOutcome,
  OAuthLinksOutcome,
  OAuthUnlinkOutcome,
} from '../oauth.js';
import { useStepUpGate, type StepUpGate } from '../step-up-react.js';
import {
  useConnectedAccountsPanel,
  type ConnectedAccountsOptions,
  type ProviderOption,
} from './connected-accounts-panel.js';

interface OAuthStub {
  listOAuthLinks: Mock;
  linkOAuthProvider: Mock;
  unlinkOAuthProvider: Mock;
  stepUp: Mock;
}

const PROVIDERS: readonly ProviderOption[] = [
  { id: 'google', displayName: 'Google' },
  { id: 'github', displayName: 'GitHub' },
];

/** Builds one link document with the fields the panel reads. */
function link(provider: string): OAuthLink {
  return {
    provider,
    email: `user@${provider}.test`,
    emailVerified: true,
    linkedAt: '2026-01-01T00:00:00Z',
    lastLoginAt: undefined,
  };
}

/** A links read carrying the given rows. */
function loaded(links: OAuthLink[]): OAuthLinksOutcome {
  return { ok: true, links };
}

/** A links read refusal, which the panel always reads as unavailable. */
function loadRefused(message: string): OAuthLinksOutcome {
  return {
    ok: false,
    reason: 'provider-unavailable',
    code: undefined,
    message,
  };
}

/** An attach the server accepted, carrying where to send the browser. */
function linkStarted(authorizationUrl: string): OAuthLinkOutcome {
  return { ok: true, authorizationUrl };
}

/** An attach the server refused. */
function linkRefused(message: string): OAuthLinkOutcome {
  return { ok: false, reason: 'already-linked', code: undefined, message };
}

/** A detach refused because it is the only way into the account. */
function lastSignInMethod(message: string): OAuthUnlinkOutcome {
  return {
    ok: false,
    reason: 'last-sign-in-method',
    code: undefined,
    message,
  };
}

/** A detach refused because the provider was not attached to begin with. */
function notLinked(message: string): OAuthUnlinkOutcome {
  return { ok: false, reason: 'not-linked', code: undefined, message };
}

/** A step-up refusal as the transport classifies it. */
function challenge(): StepUpRequiredError {
  return new StepUpRequiredError({
    status: 401,
    statusText: 'Unauthorized',
    url: 'https://api.example.test/auth/oauth/github/link',
    method: 'POST',
    body: {
      success: false,
      status: 401,
      message: 'Recent authentication required.',
      error_code: 'STEP_UP_REQUIRED',
    },
    maxAge: undefined,
  });
}

/** A stub client exposing the OAuth calls the panel makes and the step-up call. */
function stubClient(links: OAuthLink[] = []): OAuthStub {
  return {
    listOAuthLinks: vi.fn(() => Promise.resolve(loaded(links))),
    linkOAuthProvider: vi.fn(() =>
      Promise.resolve(linkStarted('https://provider.test/authorize'))
    ),
    unlinkOAuthProvider: vi.fn(() =>
      Promise.resolve({ ok: true } as OAuthUnlinkOutcome)
    ),
    stepUp: vi.fn(() => Promise.resolve({ ok: true })),
  };
}

let handle: ReturnType<typeof useConnectedAccountsPanel> | null = null;

/** Renders the panel state as text, so assertions read off the DOM. */
function AccountsProbe(options: ConnectedAccountsOptions): React.ReactNode {
  const panel = useConnectedAccountsPanel(options);
  handle = panel;
  return (
    <div>
      <span data-testid="loading">{String(panel.loading)}</span>
      <span data-testid="busy">{String(panel.busy)}</span>
      <span data-testid="error">{panel.error ?? 'none'}</span>
      <span data-testid="notice">{panel.notice ?? 'none'}</span>
      <span data-testid="unavailable">{String(panel.unavailable)}</span>
      <span data-testid="connectable">
        {panel.connectable.map((entry) => entry.id).join(',')}
      </span>
      <span data-testid="blocked">{JSON.stringify(panel.blocked)}</span>
      <span data-testid="items">
        {panel.items === null
          ? 'null'
          : panel.items.map((entry) => entry.provider).join(',')}
      </span>
    </div>
  );
}

let gateHandle: StepUpGate | null = null;

/** Renders the panel behind a real step-up gate built on the same client. */
function GatedProbe(
  options: Omit<ConnectedAccountsOptions, 'withStepUp'>
): React.ReactNode {
  const gate = useStepUpGate(options.client);
  gateHandle = gate;
  return (
    <div>
      <span data-testid="prompt">{String(gate.open)}</span>
      <AccountsProbe {...options} withStepUp={gate.withStepUp} />
    </div>
  );
}

/** Mounts the gated probe and waits for the first load to settle. */
async function mountGated(
  stub: OAuthStub,
  options: Omit<ConnectedAccountsOptions, 'client' | 'withStepUp'> = {}
): Promise<void> {
  render(
    <GatedProbe {...options} client={stub as unknown as AuthClient<unknown>} />
  );
  await waitFor(() => {
    expect(screen.getByTestId('loading').textContent).toBe('false');
  });
}

/** The step-up gate from the most recent gated render. */
function gate(): StepUpGate {
  if (gateHandle === null) {
    throw new Error('The gated probe has not rendered.');
  }
  return gateHandle;
}

/** Waits for the step-up prompt to open. */
async function promptOpen(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId('prompt').textContent).toBe('true');
  });
}

/** Mounts the probe against a stub and waits for the first load to settle. */
async function mount(
  stub: OAuthStub,
  options: Omit<ConnectedAccountsOptions, 'client'> = {}
): Promise<void> {
  render(
    <AccountsProbe
      {...options}
      client={stub as unknown as AuthClient<unknown>}
    />
  );
  await waitFor(() => {
    expect(screen.getByTestId('loading').textContent).toBe('false');
  });
}

/** The panel returned by the most recent render. */
function panel(): ReturnType<typeof useConnectedAccountsPanel> {
  if (handle === null) {
    throw new Error('The probe has not rendered.');
  }
  return handle;
}

afterEach(() => {
  handle = null;
  gateHandle = null;
  vi.restoreAllMocks();
});

describe('useConnectedAccountsPanel', () => {
  it('reads the links on mount', async () => {
    const stub = stubClient([link('google')]);

    await mount(stub, { providers: PROVIDERS });

    expect(stub.listOAuthLinks).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('items').textContent).toBe('google');
  });

  it('does not read the links when loadOnMount is false', () => {
    const stub = stubClient();

    render(
      <AccountsProbe
        client={stub as unknown as AuthClient<unknown>}
        loadOnMount={false}
      />
    );

    expect(stub.listOAuthLinks).not.toHaveBeenCalled();
  });

  it('excludes already attached providers from connectable', async () => {
    const stub = stubClient([link('google')]);

    await mount(stub, { providers: PROVIDERS });

    expect(screen.getByTestId('connectable').textContent).toBe('github');
  });

  it('offers every provider when nothing is attached', async () => {
    const stub = stubClient([]);

    await mount(stub, { providers: PROVIDERS });

    expect(screen.getByTestId('connectable').textContent).toBe('google,github');
  });

  it('reports a links refusal as unavailable with the server sentence', async () => {
    const stub = stubClient();
    stub.listOAuthLinks.mockResolvedValue(
      loadRefused('Connected accounts are switched off.')
    );

    await mount(stub, { providers: PROVIDERS });

    expect(screen.getByTestId('unavailable').textContent).toBe('true');
    expect(screen.getByTestId('error').textContent).toBe(
      'Connected accounts are switched off.'
    );
  });

  it('starts the attach with returnTo and navigates to the provider', async () => {
    const stub = stubClient();
    stub.linkOAuthProvider.mockResolvedValue(
      linkStarted('https://github.test/authorize?state=x')
    );
    const navigate = vi.fn();

    await mount(stub, {
      providers: PROVIDERS,
      returnTo: '/settings/security',
      navigate,
    });
    await act(async () => {
      await panel().link('github');
    });

    expect(stub.linkOAuthProvider).toHaveBeenCalledWith('github', {
      returnTo: '/settings/security',
    });
    expect(navigate).toHaveBeenCalledWith(
      'https://github.test/authorize?state=x'
    );
  });

  it('sends an empty options body when no returnTo is given', async () => {
    const stub = stubClient();
    const navigate = vi.fn();

    await mount(stub, { providers: PROVIDERS, navigate });
    await act(async () => {
      await panel().link('github');
    });

    expect(stub.linkOAuthProvider).toHaveBeenCalledWith('github', {});
  });

  it('stays busy after a successful attach because the page is navigating away', async () => {
    const stub = stubClient();
    const navigate = vi.fn();

    await mount(stub, { providers: PROVIDERS, navigate });
    expect(screen.getByTestId('busy').textContent).toBe('false');

    await act(async () => {
      await panel().link('github');
    });

    expect(screen.getByTestId('busy').textContent).toBe('true');
  });

  it('clears busy and reports the sentence when the attach is refused', async () => {
    const stub = stubClient();
    stub.linkOAuthProvider.mockResolvedValue(
      linkRefused('That account is already attached to another user.')
    );
    const navigate = vi.fn();

    await mount(stub, { providers: PROVIDERS, navigate });
    await act(async () => {
      await panel().link('github');
    });

    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('busy').textContent).toBe('false');
    expect(screen.getByTestId('error').textContent).toBe(
      'That account is already attached to another user.'
    );
  });

  it('marks the panel unavailable when the attach says the provider is off', async () => {
    const stub = stubClient();
    stub.linkOAuthProvider.mockResolvedValue({
      ok: false,
      reason: 'provider-unavailable',
      code: undefined,
      message: 'GitHub sign-in is switched off.',
    });

    await mount(stub, { providers: PROVIDERS, navigate: vi.fn() });
    await act(async () => {
      await panel().link('github');
    });

    expect(screen.getByTestId('unavailable').textContent).toBe('true');
  });

  it('reloads the links after a successful detach', async () => {
    const stub = stubClient([link('google'), link('github')]);

    await mount(stub, { providers: PROVIDERS });
    expect(stub.listOAuthLinks).toHaveBeenCalledTimes(1);

    await act(async () => {
      await panel().unlink('github');
    });

    expect(stub.unlinkOAuthProvider).toHaveBeenCalledWith('github');
    expect(stub.listOAuthLinks).toHaveBeenCalledTimes(2);
  });

  it('resolves a function valued removed message against the provider', async () => {
    const stub = stubClient([link('google'), link('github')]);

    await mount(stub, {
      providers: PROVIDERS,
      messages: { removed: (provider) => `Detached ${provider}.` },
    });
    await act(async () => {
      await panel().unlink('github');
    });

    expect(screen.getByTestId('notice').textContent).toBe('Detached github.');
  });

  it('blocks the provider when the detach is the last sign-in method', async () => {
    const stub = stubClient([link('google')]);
    stub.unlinkOAuthProvider.mockResolvedValue(
      lastSignInMethod('Set a password before detaching Google.')
    );

    await mount(stub, { providers: PROVIDERS });
    await act(async () => {
      await panel().unlink('google');
    });

    expect(
      JSON.parse(screen.getByTestId('blocked').textContent ?? '{}')
    ).toEqual({ google: 'Set a password before detaching Google.' });
    expect(screen.getByTestId('error').textContent).toBe(
      'Set a password before detaching Google.'
    );
  });

  it('clears blocked on the next successful reload', async () => {
    const stub = stubClient([link('google')]);
    stub.unlinkOAuthProvider.mockResolvedValue(
      lastSignInMethod('Set a password before detaching Google.')
    );

    await mount(stub, { providers: PROVIDERS });
    await act(async () => {
      await panel().unlink('google');
    });
    expect(screen.getByTestId('blocked').textContent).not.toBe('{}');

    await act(async () => {
      await panel().reload();
    });

    expect(screen.getByTestId('blocked').textContent).toBe('{}');
  });

  it('reloads the links when a detach says the provider was not attached', async () => {
    const stub = stubClient([link('google')]);
    stub.unlinkOAuthProvider.mockResolvedValue(
      notLinked('That provider is not attached.')
    );

    await mount(stub, { providers: PROVIDERS });
    expect(stub.listOAuthLinks).toHaveBeenCalledTimes(1);

    await act(async () => {
      await panel().unlink('github');
    });

    expect(stub.listOAuthLinks).toHaveBeenCalledTimes(2);
  });

  it('offers nothing connectable when no providers are given', async () => {
    const stub = stubClient([]);

    await mount(stub);

    expect(screen.getByTestId('connectable').textContent).toBe('');
  });

  it('reads the links once under StrictMode double mounting', async () => {
    const stub = stubClient([link('google')]);

    render(
      <StrictMode>
        <AccountsProbe
          client={stub as unknown as AuthClient<unknown>}
          providers={PROVIDERS}
        />
      </StrictMode>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(stub.listOAuthLinks).toHaveBeenCalledTimes(1);
  });
});

describe('useConnectedAccountsPanel with withStepUp', () => {
  it('replays the attach after the step-up and navigates', async () => {
    const stub = stubClient();
    stub.linkOAuthProvider.mockRejectedValueOnce(challenge());
    const navigate = vi.fn();

    await mountGated(stub, { providers: PROVIDERS, navigate });
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = panel().link('github');
    });
    await promptOpen();
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => {
      await gate().submit({ code: '123456' });
      await pending;
    });

    expect(stub.stepUp).toHaveBeenCalledWith({ code: '123456' });
    expect(stub.linkOAuthProvider).toHaveBeenCalledTimes(2);
    expect(navigate).toHaveBeenCalledWith('https://provider.test/authorize');
    expect(screen.getByTestId('prompt').textContent).toBe('false');
    expect(screen.getByTestId('error').textContent).toBe('none');
  });

  it('settles a cancelled attach step-up with busy cleared and no banner', async () => {
    const stub = stubClient();
    stub.linkOAuthProvider.mockRejectedValueOnce(challenge());
    const navigate = vi.fn();

    await mountGated(stub, { providers: PROVIDERS, navigate });
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = panel().link('github');
    });
    await promptOpen();
    expect(screen.getByTestId('busy').textContent).toBe('true');

    await act(async () => {
      gate().cancel();
      await expect(pending).resolves.toBeUndefined();
    });

    expect(stub.linkOAuthProvider).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('busy').textContent).toBe('false');
    expect(screen.getByTestId('error').textContent).toBe('none');
    expect(screen.getByTestId('unavailable').textContent).toBe('false');
  });

  it('replays the detach after the step-up and reloads', async () => {
    const stub = stubClient([link('google'), link('github')]);
    stub.unlinkOAuthProvider.mockRejectedValueOnce(challenge());

    await mountGated(stub, {
      providers: PROVIDERS,
      messages: { removed: (provider) => `Detached ${provider}.` },
    });
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = panel().unlink('github');
    });
    await promptOpen();
    expect(stub.listOAuthLinks).toHaveBeenCalledTimes(1);

    await act(async () => {
      await gate().submit({ code: '123456' });
      await pending;
    });

    expect(stub.unlinkOAuthProvider).toHaveBeenCalledTimes(2);
    expect(stub.unlinkOAuthProvider).toHaveBeenLastCalledWith('github');
    expect(stub.listOAuthLinks).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('notice').textContent).toBe('Detached github.');
    expect(screen.getByTestId('error').textContent).toBe('none');
  });

  it('settles a cancelled detach step-up with busy cleared and no banner', async () => {
    const stub = stubClient([link('google'), link('github')]);
    stub.unlinkOAuthProvider.mockRejectedValueOnce(challenge());

    await mountGated(stub, {
      providers: PROVIDERS,
      messages: { removed: (provider) => `Detached ${provider}.` },
    });
    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = panel().unlink('github');
    });
    await promptOpen();
    expect(screen.getByTestId('busy').textContent).toBe('true');

    await act(async () => {
      gate().cancel();
      await expect(pending).resolves.toBeUndefined();
    });

    expect(stub.unlinkOAuthProvider).toHaveBeenCalledTimes(1);
    expect(stub.listOAuthLinks).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('busy').textContent).toBe('false');
    expect(screen.getByTestId('error').textContent).toBe('none');
    expect(screen.getByTestId('notice').textContent).toBe('none');
    expect(screen.getByTestId('blocked').textContent).toBe('{}');
  });

  it('passes a refusal through the wrapper unchanged', async () => {
    const stub = stubClient([link('google')]);
    stub.unlinkOAuthProvider.mockResolvedValue(
      lastSignInMethod('Set a password before detaching Google.')
    );

    await mountGated(stub, { providers: PROVIDERS });
    await act(async () => {
      await panel().unlink('google');
    });

    expect(screen.getByTestId('prompt').textContent).toBe('false');
    expect(screen.getByTestId('error').textContent).toBe(
      'Set a password before detaching Google.'
    );
  });
});
