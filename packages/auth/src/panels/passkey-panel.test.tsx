import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthClient } from '../auth-client.js';
import type {
  Passkey,
  PasskeyDeleteOutcome,
  PasskeyListOutcome,
  PasskeyRegistrationOutcome,
  PasskeyRenameOutcome,
} from '../passkeys.js';
import { usePasskeyPanel, type PasskeyPanelOptions } from './passkey-panel.js';

interface PasskeyStub {
  listPasskeys: ReturnType<typeof vi.fn>;
  registerPasskey: ReturnType<typeof vi.fn>;
  renamePasskey: ReturnType<typeof vi.fn>;
  deletePasskey: ReturnType<typeof vi.fn>;
}

/** Builds one passkey document with the fields the panel reads. */
function passkey(overrides: Partial<Passkey> = {}): Passkey {
  return {
    credentialId: 'cred_1',
    name: 'MacBook',
    createdAt: '2026-01-01T00:00:00Z',
    lastUsedAt: undefined,
    transports: ['internal'],
    aaguid: '',
    backupEligible: false,
    backupState: false,
    userVerified: true,
    ...overrides,
  };
}

/** A list success carrying the given rows. */
function listed(passkeys: Passkey[]): PasskeyListOutcome {
  return { ok: true, passkeys };
}

/** A list refusal, which the panel always reads as unavailable. */
function listRefused(message: string): PasskeyListOutcome {
  return { ok: false, reason: 'unavailable', code: undefined, message };
}

/** A registration success carrying the credential the server settled on. */
function registered(created: Passkey): PasskeyRegistrationOutcome {
  return { ok: true, passkey: created };
}

/** A registration the user dismissed in the browser prompt. */
function cancelled(): PasskeyRegistrationOutcome {
  return {
    ok: false,
    reason: 'cancelled',
    code: undefined,
    message: 'The passkey prompt was dismissed.',
  };
}

/** A rename refusal saying the credential is already gone. */
function renameNotFound(message: string): PasskeyRenameOutcome {
  return { ok: false, reason: 'not-found', code: undefined, message };
}

/** A delete refusal saying the credential is already gone. */
function deleteNotFound(message: string): PasskeyDeleteOutcome {
  return { ok: false, reason: 'not-found', code: undefined, message };
}

/** A stub client exposing only the four passkey calls the panel makes. */
function stubClient(rows: Passkey[] = []): PasskeyStub {
  return {
    listPasskeys: vi.fn(() => Promise.resolve(listed(rows))),
    registerPasskey: vi.fn(() =>
      Promise.resolve(registered(passkey({ credentialId: 'cred_new' })))
    ),
    renamePasskey: vi.fn(() =>
      Promise.resolve({ ok: true, passkey: passkey() } as PasskeyRenameOutcome)
    ),
    deletePasskey: vi.fn(() =>
      Promise.resolve({ ok: true } as PasskeyDeleteOutcome)
    ),
  };
}

let handle: ReturnType<typeof usePasskeyPanel> | null = null;

/** Renders the panel state as text, so assertions read off the DOM. */
function PasskeyProbe(options: PasskeyPanelOptions): React.ReactNode {
  const panel = usePasskeyPanel(options);
  handle = panel;
  return (
    <div>
      <span data-testid="loading">{String(panel.loading)}</span>
      <span data-testid="busy">{String(panel.busy)}</span>
      <span data-testid="error">{panel.error ?? 'none'}</span>
      <span data-testid="notice">{panel.notice ?? 'none'}</span>
      <span data-testid="unavailable">{String(panel.unavailable)}</span>
      <span data-testid="supported">{String(panel.supported)}</span>
      <span data-testid="dirty">{String(panel.dirty)}</span>
      <span data-testid="adding">{String(panel.adding)}</span>
      <span data-testid="draft-name">{panel.draftName}</span>
      <span data-testid="renaming">{panel.renaming ?? 'none'}</span>
      <span data-testid="draft-rename">{panel.draftRename}</span>
      <span data-testid="items">
        {panel.items === null
          ? 'null'
          : panel.items.map((entry) => entry.name).join(',')}
      </span>
    </div>
  );
}

/** Mounts the probe against a stub and waits for the first load to settle. */
async function mount(
  stub: PasskeyStub,
  options: Omit<PasskeyPanelOptions, 'client'> = {}
): Promise<void> {
  render(
    <PasskeyProbe
      {...options}
      client={stub as unknown as AuthClient<unknown>}
    />
  );
  await waitFor(() => {
    expect(screen.getByTestId('loading').textContent).toBe('false');
  });
}

/** The panel returned by the most recent render. */
function panel(): ReturnType<typeof usePasskeyPanel> {
  if (handle === null) {
    throw new Error('The probe has not rendered.');
  }
  return handle;
}

afterEach(() => {
  handle = null;
  vi.restoreAllMocks();
});

describe('usePasskeyPanel', () => {
  it('reads the list on mount', async () => {
    const stub = stubClient([passkey({ name: 'MacBook' })]);

    await mount(stub);

    expect(stub.listPasskeys).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('items').textContent).toBe('MacBook');
    expect(screen.getByTestId('error').textContent).toBe('none');
  });

  it('does not read the list when loadOnMount is false', () => {
    const stub = stubClient();

    render(
      <PasskeyProbe
        client={stub as unknown as AuthClient<unknown>}
        loadOnMount={false}
      />
    );

    expect(stub.listPasskeys).not.toHaveBeenCalled();
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('items').textContent).toBe('null');
  });

  it('reports a list refusal as unavailable with the server sentence', async () => {
    const stub = stubClient();
    stub.listPasskeys.mockResolvedValue(
      listRefused('Passkeys are switched off in this deployment.')
    );

    await mount(stub);

    expect(screen.getByTestId('unavailable').textContent).toBe('true');
    expect(screen.getByTestId('error').textContent).toBe(
      'Passkeys are switched off in this deployment.'
    );
  });

  it('trims the draft name before enrolling', async () => {
    const stub = stubClient();

    await mount(stub);
    await act(async () => {
      await panel().create('  Work laptop  ');
    });

    expect(stub.registerPasskey).toHaveBeenCalledWith({ name: 'Work laptop' });
  });

  it('sends an empty body when the trimmed name is empty', async () => {
    const stub = stubClient();

    await mount(stub);
    await act(async () => {
      await panel().create('   ');
    });

    expect(stub.registerPasskey).toHaveBeenCalledWith({});
  });

  it('resolves a function valued created message against the new credential', async () => {
    const stub = stubClient();
    stub.registerPasskey.mockResolvedValue(
      registered(passkey({ credentialId: 'cred_new', name: 'Phone' }))
    );

    await mount(stub, {
      messages: { created: (entry) => `Added ${entry.name}.` },
    });
    await act(async () => {
      await panel().create('Phone');
    });

    expect(screen.getByTestId('notice').textContent).toBe('Added Phone.');
    expect(screen.getByTestId('dirty').textContent).toBe('true');
  });

  it('leaves both banners clear when the user dismisses the prompt', async () => {
    const stub = stubClient();
    stub.registerPasskey.mockResolvedValue(cancelled());

    await mount(stub, { messages: { created: 'Added.' } });
    await act(async () => {
      await panel().create('Phone');
    });

    expect(screen.getByTestId('error').textContent).toBe('none');
    expect(screen.getByTestId('notice').textContent).toBe('none');
    expect(screen.getByTestId('dirty').textContent).toBe('false');
  });

  it('reloads the list when a rename says the credential is gone', async () => {
    const stub = stubClient([passkey()]);
    stub.renamePasskey.mockResolvedValue(
      renameNotFound('That passkey no longer exists.')
    );

    await mount(stub);
    expect(stub.listPasskeys).toHaveBeenCalledTimes(1);

    await act(async () => {
      await panel().rename('cred_1', 'Renamed');
    });

    expect(stub.listPasskeys).toHaveBeenCalledTimes(2);
  });

  it('keeps the server sentence after a stale rename reloads', async () => {
    const stub = stubClient([passkey()]);
    stub.renamePasskey.mockResolvedValue(
      renameNotFound('That passkey no longer exists.')
    );

    await mount(stub);
    await act(async () => {
      await panel().rename('cred_1', 'Renamed');
    });

    expect(screen.getByTestId('error').textContent).toBe(
      'That passkey no longer exists.'
    );
  });

  it('reloads the list when a delete says the credential is gone', async () => {
    const stub = stubClient([passkey()]);
    stub.deletePasskey.mockResolvedValue(
      deleteNotFound('That passkey no longer exists.')
    );

    await mount(stub);

    await act(async () => {
      await panel().remove('cred_1');
    });

    expect(stub.listPasskeys).toHaveBeenCalledTimes(2);
  });

  it('trims the name a rename sends', async () => {
    const stub = stubClient([passkey()]);

    await mount(stub);
    await act(async () => {
      await panel().rename('cred_1', '  Desk key  ');
    });

    expect(stub.renamePasskey).toHaveBeenCalledWith('cred_1', 'Desk key');
  });

  it('opens the rename form seeded with the row name', async () => {
    const stub = stubClient([passkey({ name: 'MacBook' })]);

    await mount(stub);
    act(() => {
      panel().startRename(passkey({ credentialId: 'cred_1', name: 'MacBook' }));
    });

    expect(screen.getByTestId('renaming').textContent).toBe('cred_1');
    expect(screen.getByTestId('draft-rename').textContent).toBe('MacBook');
  });

  it('commits the open rename and closes the form', async () => {
    const stub = stubClient([passkey()]);

    await mount(stub);
    act(() => {
      panel().startRename(passkey({ credentialId: 'cred_1', name: 'MacBook' }));
    });
    act(() => {
      panel().setDraftRename('Studio');
    });
    await act(async () => {
      await panel().commitRename();
    });

    expect(stub.renamePasskey).toHaveBeenCalledWith('cred_1', 'Studio');
    expect(screen.getByTestId('renaming').textContent).toBe('none');
    expect(screen.getByTestId('draft-rename').textContent).toBe('');
  });

  it('discards the rename draft on cancel', async () => {
    const stub = stubClient([passkey()]);

    await mount(stub);
    act(() => {
      panel().startRename(passkey({ credentialId: 'cred_1', name: 'MacBook' }));
    });
    act(() => {
      panel().cancelRename();
    });

    expect(screen.getByTestId('renaming').textContent).toBe('none');
    expect(screen.getByTestId('draft-rename').textContent).toBe('');
    expect(stub.renamePasskey).not.toHaveBeenCalled();
  });

  it('does nothing when a rename is committed with no row open', async () => {
    const stub = stubClient([passkey()]);

    await mount(stub);
    await act(async () => {
      await panel().commitRename();
    });

    expect(stub.renamePasskey).not.toHaveBeenCalled();
  });

  it('opens the add form with an empty draft', async () => {
    const stub = stubClient();

    await mount(stub);
    act(() => {
      panel().setDraftName('stale');
    });
    act(() => {
      panel().startCreate();
    });

    expect(screen.getByTestId('adding').textContent).toBe('true');
    expect(screen.getByTestId('draft-name').textContent).toBe('');
  });

  it('commits the add form draft and closes it', async () => {
    const stub = stubClient();

    await mount(stub);
    act(() => {
      panel().startCreate();
    });
    act(() => {
      panel().setDraftName('Yubikey');
    });
    await act(async () => {
      await panel().commitCreate();
    });

    expect(stub.registerPasskey).toHaveBeenCalledWith({ name: 'Yubikey' });
    expect(screen.getByTestId('adding').textContent).toBe('false');
    expect(screen.getByTestId('draft-name').textContent).toBe('');
  });

  it('discards the add form draft on cancel', async () => {
    const stub = stubClient();

    await mount(stub);
    act(() => {
      panel().startCreate();
    });
    act(() => {
      panel().setDraftName('Yubikey');
    });
    act(() => {
      panel().cancelCreate();
    });

    expect(screen.getByTestId('adding').textContent).toBe('false');
    expect(screen.getByTestId('draft-name').textContent).toBe('');
    expect(stub.registerPasskey).not.toHaveBeenCalled();
  });

  it('clears both banners on dismiss', async () => {
    const stub = stubClient();
    stub.registerPasskey.mockResolvedValue(
      registered(passkey({ name: 'Phone' }))
    );

    await mount(stub, { messages: { created: 'Added.' } });
    await act(async () => {
      await panel().create('Phone');
    });
    expect(screen.getByTestId('notice').textContent).toBe('Added.');

    act(() => {
      panel().dismiss();
    });

    expect(screen.getByTestId('notice').textContent).toBe('none');
    expect(screen.getByTestId('error').textContent).toBe('none');
  });

  it('reports supported when the browser exposes PublicKeyCredential', async () => {
    vi.stubGlobal('PublicKeyCredential', function PublicKeyCredential() {
      return undefined;
    });
    const stub = stubClient();

    await mount(stub);

    expect(screen.getByTestId('supported').textContent).toBe('true');
    vi.unstubAllGlobals();
  });

  it('reports unsupported when the browser has no PublicKeyCredential', async () => {
    vi.stubGlobal('PublicKeyCredential', undefined);
    const stub = stubClient();

    await mount(stub);

    expect(screen.getByTestId('supported').textContent).toBe('false');
    vi.unstubAllGlobals();
  });

  it('reads the list once under StrictMode double mounting', async () => {
    const stub = stubClient([passkey()]);

    render(
      <StrictMode>
        <PasskeyProbe client={stub as unknown as AuthClient<unknown>} />
      </StrictMode>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(stub.listPasskeys).toHaveBeenCalledTimes(1);
  });
});
