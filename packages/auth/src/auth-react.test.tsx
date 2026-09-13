import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createAuthClient, type AuthClient } from './auth-client.js';
import {
  AuthProvider,
  useAuth,
  useAuthClient,
  type AnyAuthClient,
} from './react.js';

interface User {
  id: string;
  email: string;
}

const ALICE: User = { id: 'u_1', email: 'alice@example.test' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function clientWith(
  responses: (call: number) => Response,
  loadUser: () => Promise<User | null> = () => Promise.resolve(ALICE)
): {
  client: AuthClient<User>;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  let calls = 0;
  const fetchMock = vi.fn(() => {
    const response = responses(calls);
    calls += 1;
    return Promise.resolve(response);
  });
  const client = createAuthClient<User>({
    baseUrl: 'https://api.example.test',
    disableProactiveRefresh: true,
    loadUser,
    clientOptions: {
      fetch: fetchMock,
      retries: 0,
    },
  });
  return { client, fetchMock };
}

/** Renders the auth state as text, so assertions read off the DOM. */
function AuthProbe(): React.ReactNode {
  const { status, user, isAuthenticated, isLoading, isBusy, pendingMfa } =
    useAuth<User>();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.email ?? 'none'}</span>
      <span data-testid="authenticated">{String(isAuthenticated)}</span>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="busy">{String(isBusy)}</span>
      <span data-testid="pending-mfa">{pendingMfa?.ticket ?? 'none'}</span>
    </div>
  );
}

describe('AuthProvider', () => {
  it('runs the silent refresh on mount and renders the session', async () => {
    const { client } = clientWith(() =>
      jsonResponse({ access_token: 'a1', expires_in: 600 })
    );

    render(
      <AuthProvider client={client as unknown as AnyAuthClient}>
        <AuthProbe />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });
    expect(screen.getByTestId('user').textContent).toBe(ALICE.email);
    expect(screen.getByTestId('authenticated').textContent).toBe('true');
    expect(screen.getByTestId('loading').textContent).toBe('false');
  });

  it('renders anonymous when there is no cookie', async () => {
    const { client } = clientWith(() =>
      jsonResponse(
        {
          success: false,
          status: 401,
          message: 'No session.',
          request_id: 'r',
        },
        401
      )
    );

    render(
      <AuthProvider client={client as unknown as AnyAuthClient}>
        <AuthProbe />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('anonymous');
    });
    expect(screen.getByTestId('authenticated').textContent).toBe('false');
  });

  it('makes one refresh call under StrictMode double mounting', async () => {
    const { client, fetchMock } = clientWith(() =>
      jsonResponse({ access_token: 'a1', expires_in: 600 })
    );

    render(
      <StrictMode>
        <AuthProvider client={client as unknown as AnyAuthClient}>
          <AuthProbe />
        </AuthProvider>
      </StrictMode>
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips the silent refresh when asked', () => {
    const { client, fetchMock } = clientWith(() =>
      jsonResponse({ access_token: 'a1', expires_in: 600 })
    );

    render(
      <AuthProvider
        client={client as unknown as AnyAuthClient}
        initializeOnMount={false}
      >
        <AuthProbe />
      </AuthProvider>
    );

    expect(screen.getByTestId('status').textContent).toBe('unknown');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws outside a provider', () => {
    function Orphan(): React.ReactNode {
      useAuthClient();
      return null;
    }
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    expect(() => render(<Orphan />)).toThrow(
      /useAuthClient must be used within an AuthProvider/
    );
    consoleError.mockRestore();
  });
});

describe('useAuth', () => {
  it('re-renders on a logout and reports the anonymous state', async () => {
    const { client } = clientWith((call) =>
      call === 0
        ? jsonResponse({ access_token: 'a1', expires_in: 600 })
        : new Response(null, { status: 204 })
    );

    render(
      <AuthProvider client={client as unknown as AnyAuthClient}>
        <AuthProbe />
      </AuthProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });

    await act(async () => {
      await client.logout();
    });

    expect(screen.getByTestId('status').textContent).toBe('anonymous');
    expect(screen.getByTestId('user').textContent).toBe('none');
  });

  it('exposes setUser, which re-renders with no request', async () => {
    const BOB: User = { id: 'u_1', email: 'bob@example.test' };
    function Renamer(): React.ReactNode {
      const { user, setUser } = useAuth<User>();
      return (
        <div>
          <span data-testid="email">{user?.email ?? 'none'}</span>
          <button
            type="button"
            onClick={() => {
              setUser(BOB);
            }}
          >
            rename
          </button>
        </div>
      );
    }
    const { client, fetchMock } = clientWith(() =>
      jsonResponse({ access_token: 'a1', expires_in: 600 })
    );

    render(
      <AuthProvider client={client as unknown as AnyAuthClient}>
        <Renamer />
      </AuthProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('email').textContent).toBe(ALICE.email);
    });
    const callsBefore = fetchMock.mock.calls.length;

    act(() => {
      screen.getByRole('button', { name: 'rename' }).click();
    });

    expect(screen.getByTestId('email').textContent).toBe(BOB.email);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('exposes reloadUser, which re-renders without rotating the token', async () => {
    const BOB: User = { id: 'u_1', email: 'bob@example.test' };
    let loads = 0;
    const { client, fetchMock } = clientWith(
      () => jsonResponse({ access_token: 'a1', expires_in: 600 }),
      () => {
        loads += 1;
        return Promise.resolve(loads === 1 ? ALICE : BOB);
      }
    );

    function Reloader(): React.ReactNode {
      const { user, reloadUser } = useAuth<User>();
      return (
        <div>
          <span data-testid="email">{user?.email ?? 'none'}</span>
          <button
            type="button"
            onClick={() => {
              void reloadUser();
            }}
          >
            reload
          </button>
        </div>
      );
    }

    render(
      <AuthProvider client={client as unknown as AnyAuthClient}>
        <Reloader />
      </AuthProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('email').textContent).toBe(ALICE.email);
    });
    const callsBefore = fetchMock.mock.calls.length;

    act(() => {
      screen.getByRole('button', { name: 'reload' }).click();
    });

    await waitFor(() => {
      expect(screen.getByTestId('email').textContent).toBe(BOB.email);
    });
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
    expect(client.getAccessToken()).toBe('a1');
  });

  it('keeps its methods stable across state changes', async () => {
    const seen: (() => unknown)[] = [];
    function Capture(): React.ReactNode {
      const { logout } = useAuth<User>();
      seen.push(logout);
      return null;
    }
    const { client } = clientWith(() =>
      jsonResponse({ access_token: 'a1', expires_in: 600 })
    );

    render(
      <AuthProvider client={client as unknown as AnyAuthClient}>
        <Capture />
      </AuthProvider>
    );
    await waitFor(() => {
      expect(seen.length).toBeGreaterThan(1);
    });

    expect(new Set(seen).size).toBe(1);
  });
});

describe('useAuth isLoading and isBusy', () => {
  /**
   * A client whose next response is handed over by the test, so a call can be
   * observed while it is still in flight.
   */
  function deferrableClient(): {
    client: AuthClient<User>;
    resolveNext: (response: Response) => void;
  } {
    let release: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    const client = createAuthClient<User>({
      baseUrl: 'https://api.example.test',
      disableProactiveRefresh: true,
      loadUser: () => Promise.resolve(ALICE),
      clientOptions: { fetch: fetchMock, retries: 0 },
    });
    return {
      client,
      resolveNext: (response) => {
        if (release === null) {
          throw new Error('No request is waiting for a response.');
        }
        release(response);
        release = null;
      },
    };
  }

  it('is loading before the session has ever settled', () => {
    const { client } = clientWith(() =>
      jsonResponse({ access_token: 'a1', expires_in: 600 })
    );

    render(
      <AuthProvider client={client as unknown as AnyAuthClient}>
        <AuthProbe />
      </AuthProvider>
    );

    expect(screen.getByTestId('loading').textContent).toBe('true');
    expect(screen.getByTestId('authenticated').textContent).toBe('false');
  });

  it('is loading before the mount refresh has been started', () => {
    const { client } = clientWith(() =>
      jsonResponse({ access_token: 'a1', expires_in: 600 })
    );

    render(
      <AuthProvider
        client={client as unknown as AnyAuthClient}
        initializeOnMount={false}
      >
        <AuthProbe />
      </AuthProvider>
    );

    expect(screen.getByTestId('status').textContent).toBe('unknown');
    expect(screen.getByTestId('loading').textContent).toBe('true');
    expect(screen.getByTestId('busy').textContent).toBe('false');
  });

  it('keeps a login that answers mfa_required mounted, with the challenge', async () => {
    const { client, resolveNext } = deferrableClient();

    render(
      <AuthProvider client={client as unknown as AnyAuthClient}>
        <AuthProbe />
      </AuthProvider>
    );

    await act(async () => {
      resolveNext(
        jsonResponse(
          {
            success: false,
            status: 401,
            message: 'No session.',
            request_id: 'r',
          },
          401
        )
      );
      await client.initialize();
    });
    expect(screen.getByTestId('status').textContent).toBe('anonymous');
    expect(screen.getByTestId('loading').textContent).toBe('false');

    let login: Promise<unknown>;
    act(() => {
      login = client.login({ email: 'a@b.test', password: 'pw' });
    });

    expect(screen.getByTestId('status').textContent).toBe('loading');
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('busy').textContent).toBe('true');

    await act(async () => {
      resolveNext(
        jsonResponse({
          mfa_required: true,
          mfa_ticket: 'tkt_1',
          factors: ['totp'],
        })
      );
      await login;
    });

    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('busy').textContent).toBe('false');
    expect(screen.getByTestId('pending-mfa').textContent).toBe('tkt_1');
  });

  it('reports authenticated after the login succeeds', async () => {
    const { client } = clientWith((call) =>
      call === 0
        ? jsonResponse(
            {
              success: false,
              status: 401,
              message: 'No session.',
              request_id: 'r',
            },
            401
          )
        : jsonResponse({ access_token: 'a1', expires_in: 600, user: ALICE })
    );

    render(
      <AuthProvider client={client as unknown as AnyAuthClient}>
        <AuthProbe />
      </AuthProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('anonymous');
    });

    await act(async () => {
      await client.login({ email: 'a@b.test', password: 'pw' });
    });

    expect(screen.getByTestId('authenticated').textContent).toBe('true');
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('busy').textContent).toBe('false');
  });

  it('stays authenticated while a call is in flight on a live session', async () => {
    const { client, resolveNext } = deferrableClient();

    render(
      <AuthProvider client={client as unknown as AnyAuthClient}>
        <AuthProbe />
      </AuthProvider>
    );

    await act(async () => {
      resolveNext(jsonResponse({ access_token: 'a1', expires_in: 600 }));
      await client.initialize();
    });
    expect(screen.getByTestId('authenticated').textContent).toBe('true');

    let stepUp: Promise<unknown>;
    act(() => {
      stepUp = client.stepUp({ code: '123456' });
    });

    expect(screen.getByTestId('status').textContent).toBe('loading');
    expect(screen.getByTestId('busy').textContent).toBe('true');
    expect(screen.getByTestId('authenticated').textContent).toBe('true');

    await act(async () => {
      resolveNext(jsonResponse({ access_token: 'a2', expires_in: 600 }));
      await stepUp;
    });

    expect(screen.getByTestId('authenticated').textContent).toBe('true');
  });

  it('does not claim authenticated while a login from anonymous is in flight', async () => {
    const { client, resolveNext } = deferrableClient();

    render(
      <AuthProvider client={client as unknown as AnyAuthClient}>
        <AuthProbe />
      </AuthProvider>
    );

    await act(async () => {
      resolveNext(
        jsonResponse(
          {
            success: false,
            status: 401,
            message: 'No session.',
            request_id: 'r',
          },
          401
        )
      );
      await client.initialize();
    });
    expect(screen.getByTestId('authenticated').textContent).toBe('false');

    let login: Promise<unknown>;
    act(() => {
      login = client.login({ email: 'a@b.test', password: 'pw' });
    });

    expect(screen.getByTestId('busy').textContent).toBe('true');
    expect(screen.getByTestId('authenticated').textContent).toBe('false');

    await act(async () => {
      resolveNext(jsonResponse({ access_token: 'a1', expires_in: 600 }));
      await login;
    });

    expect(screen.getByTestId('authenticated').textContent).toBe('true');
  });

  it('stays settled through a logout', async () => {
    const { client } = clientWith((call) =>
      call === 0
        ? jsonResponse({ access_token: 'a1', expires_in: 600 })
        : new Response(null, { status: 204 })
    );

    render(
      <AuthProvider client={client as unknown as AnyAuthClient}>
        <AuthProbe />
      </AuthProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });

    await act(async () => {
      await client.logout();
    });

    expect(screen.getByTestId('status').textContent).toBe('anonymous');
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('busy').textContent).toBe('false');
  });
});
