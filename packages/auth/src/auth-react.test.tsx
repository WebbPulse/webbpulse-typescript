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
  const { status, user, isAuthenticated, isLoading } = useAuth<User>();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.email ?? 'none'}</span>
      <span data-testid="authenticated">{String(isAuthenticated)}</span>
      <span data-testid="loading">{String(isLoading)}</span>
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
