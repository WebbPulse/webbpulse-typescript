import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';

import type {
  AccountSession,
  SessionListOutcome,
  SessionRevokeOthersOutcome,
  SessionRevokeOutcome,
} from '../account.js';
import type { AuthClient } from '../auth-client.js';
import {
  useSessionsPanel,
  type SessionsPanelOptions,
} from './sessions-panel.js';

interface SessionsStub {
  listSessions: Mock;
  revokeSession: Mock;
  revokeOtherSessions: Mock;
}

/** Builds one session with the fields the panel reads. */
function session(overrides: Partial<AccountSession> = {}): AccountSession {
  return {
    id: 'fam_1',
    device: 'desktop',
    ip: '203.0.113.1',
    lastIp: '203.0.113.1',
    client: '',
    platform: 'macOS',
    clientId: '',
    startedAt: '2026-10-01T00:00:00+00:00',
    lastActiveAt: '2026-10-02T00:00:00+00:00',
    expiresAt: null,
    amr: ['pwd'],
    current: false,
    ...overrides,
  };
}

/** A list success carrying the given rows. */
function listed(sessions: AccountSession[]): SessionListOutcome {
  return { ok: true, sessions };
}

/** A single revoke refusal. */
function refused(
  reason: 'not-found' | 'current-session',
  message: string
): SessionRevokeOutcome {
  return { ok: false, reason, code: undefined, message };
}

/** A stub client exposing only the three session calls the panel makes. */
function stubClient(rows: AccountSession[] = []): SessionsStub {
  return {
    listSessions: vi.fn(() => Promise.resolve(listed(rows))),
    revokeSession: vi.fn(() =>
      Promise.resolve({ ok: true } as SessionRevokeOutcome)
    ),
    revokeOtherSessions: vi.fn(() =>
      Promise.resolve({ ok: true, revoked: 2 } as SessionRevokeOthersOutcome)
    ),
  };
}

let handle: ReturnType<typeof useSessionsPanel> | null = null;

/** Renders the panel state as text, so assertions read off the DOM. */
function SessionsProbe(options: SessionsPanelOptions): React.ReactNode {
  const panel = useSessionsPanel(options);
  handle = panel;
  return (
    <div>
      <span data-testid="loading">{String(panel.loading)}</span>
      <span data-testid="busy">{String(panel.busy)}</span>
      <span data-testid="error">{panel.error ?? 'none'}</span>
      <span data-testid="notice">{panel.notice ?? 'none'}</span>
      <span data-testid="dirty">{String(panel.dirty)}</span>
      <span data-testid="current">{panel.current?.id ?? 'none'}</span>
      <span data-testid="others">
        {panel.others.map((entry) => entry.id).join(',')}
      </span>
      <span data-testid="items">
        {panel.items === null
          ? 'null'
          : panel.items.map((entry) => entry.id).join(',')}
      </span>
    </div>
  );
}

/** Mounts the probe against a stub and waits for the first load to settle. */
async function mount(
  stub: SessionsStub,
  options: Omit<SessionsPanelOptions, 'client'> = {}
): Promise<void> {
  render(
    <SessionsProbe
      {...options}
      client={stub as unknown as AuthClient<unknown>}
    />
  );
  await waitFor(() => {
    expect(screen.getByTestId('loading').textContent).toBe('false');
  });
}

/** The panel returned by the most recent render. */
function panel(): ReturnType<typeof useSessionsPanel> {
  if (handle === null) {
    throw new Error('The probe has not rendered.');
  }
  return handle;
}

const ROWS = [
  session({ id: 'fam_1', current: true }),
  session({ id: 'fam_2', device: 'mobile' }),
  session({ id: 'fam_3' }),
];

afterEach(() => {
  handle = null;
  vi.restoreAllMocks();
});

describe('useSessionsPanel', () => {
  it('reads the list on mount and splits out the current session', async () => {
    const stub = stubClient(ROWS);

    await mount(stub);

    expect(stub.listSessions).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('items').textContent).toBe('fam_1,fam_2,fam_3');
    expect(screen.getByTestId('current').textContent).toBe('fam_1');
    expect(screen.getByTestId('others').textContent).toBe('fam_2,fam_3');
  });

  it('does not read the list when loadOnMount is false', () => {
    const stub = stubClient();

    render(
      <SessionsProbe
        client={stub as unknown as AuthClient<unknown>}
        loadOnMount={false}
      />
    );

    expect(stub.listSessions).not.toHaveBeenCalled();
    expect(screen.getByTestId('items').textContent).toBe('null');
    expect(screen.getByTestId('current').textContent).toBe('none');
  });

  it('reports a list that throws with the failed sentence', async () => {
    const stub = stubClient();
    stub.listSessions.mockRejectedValue(new Error('offline'));

    await mount(stub, { messages: { failed: 'Could not load sessions.' } });

    expect(screen.getByTestId('error').textContent).toBe(
      'Could not load sessions.'
    );
    expect(screen.getByTestId('items').textContent).toBe('null');
  });

  it('revokes one session, shows the removed notice and reloads', async () => {
    const stub = stubClient(ROWS);

    await mount(stub, { messages: { removed: 'Session ended.' } });
    stub.listSessions.mockResolvedValue(listed([ROWS[0]!, ROWS[2]!]));
    await act(async () => {
      await panel().revoke('fam_2');
    });

    expect(stub.revokeSession).toHaveBeenCalledWith('fam_2');
    expect(stub.listSessions).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('notice').textContent).toBe('Session ended.');
    expect(screen.getByTestId('others').textContent).toBe('fam_3');
    expect(screen.getByTestId('dirty').textContent).toBe('true');
  });

  it('counts a session already gone as ended', async () => {
    const stub = stubClient(ROWS);
    stub.revokeSession.mockResolvedValue(
      refused('not-found', 'No such session.')
    );

    await mount(stub, { messages: { removed: 'Session ended.' } });
    await act(async () => {
      await panel().revoke('fam_2');
    });

    expect(screen.getByTestId('error').textContent).toBe('none');
    expect(screen.getByTestId('notice').textContent).toBe('Session ended.');
    expect(stub.listSessions).toHaveBeenCalledTimes(2);
  });

  it('surfaces the server sentence when the current session is refused', async () => {
    const stub = stubClient(ROWS);
    stub.revokeSession.mockResolvedValue(
      refused(
        'current-session',
        'This is the session you are using. Sign out to end it.'
      )
    );

    await mount(stub);
    await act(async () => {
      await panel().revoke('fam_1');
    });

    expect(screen.getByTestId('error').textContent).toBe(
      'This is the session you are using. Sign out to end it.'
    );
    expect(stub.listSessions).toHaveBeenCalledTimes(1);
  });

  it('reports a revoke that throws with the failed sentence', async () => {
    const stub = stubClient(ROWS);
    stub.revokeSession.mockRejectedValue(new Error('offline'));

    await mount(stub, { messages: { failed: 'Try again.' } });
    await act(async () => {
      await panel().revoke('fam_2');
    });

    expect(screen.getByTestId('error').textContent).toBe('Try again.');
    expect(screen.getByTestId('busy').textContent).toBe('false');
  });

  it('revokes every other session in one call and reloads', async () => {
    const stub = stubClient(ROWS);

    await mount(stub, {
      messages: { revokedOthers: (count) => `${count} sessions ended.` },
    });
    stub.listSessions.mockResolvedValue(listed([ROWS[0]!]));
    await act(async () => {
      await panel().revokeOthers();
    });

    expect(stub.revokeOtherSessions).toHaveBeenCalledTimes(1);
    expect(stub.revokeSession).not.toHaveBeenCalled();
    expect(screen.getByTestId('notice').textContent).toBe('2 sessions ended.');
    expect(screen.getByTestId('current').textContent).toBe('fam_1');
    expect(screen.getByTestId('others').textContent).toBe('');
  });

  it('takes a plain string for the revoke others notice', async () => {
    const stub = stubClient(ROWS);

    await mount(stub, { messages: { revokedOthers: 'Signed out elsewhere.' } });
    await act(async () => {
      await panel().revokeOthers();
    });

    expect(screen.getByTestId('notice').textContent).toBe(
      'Signed out elsewhere.'
    );
  });

  it('reports a revoke others that throws with the failed sentence', async () => {
    const stub = stubClient(ROWS);
    stub.revokeOtherSessions.mockRejectedValue(new Error('offline'));

    await mount(stub);
    await act(async () => {
      await panel().revokeOthers();
    });

    expect(screen.getByTestId('error').textContent).toBe(
      'Could not reach the server. Check your connection and try again.'
    );
    expect(stub.listSessions).toHaveBeenCalledTimes(1);
  });

  it('reads the list once under StrictMode double mounting', async () => {
    const stub = stubClient(ROWS);

    render(
      <StrictMode>
        <SessionsProbe client={stub as unknown as AuthClient<unknown>} />
      </StrictMode>
    );

    await waitFor(() => {
      expect(screen.getByTestId('loading').textContent).toBe('false');
    });
    expect(stub.listSessions).toHaveBeenCalledTimes(1);
  });
});
