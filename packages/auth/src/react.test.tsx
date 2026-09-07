import { createApiClient } from '@webbpulse/api-client';
import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from './session.js';
import { MemoryTokenStorage } from './storage.js';
import {
  SessionProvider,
  useSession,
  useSessionManager,
  useSessionState,
  type AnySessionManager,
} from './react.js';

interface User {
  id: number;
  username: string;
}

const ALICE: User = { id: 1, username: 'alice' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function managerWith(
  results: (Response | Error)[]
): SessionManager<User, { username: string }> {
  let index = 0;
  const fetchMock = vi.fn(() => {
    const result = results.at(Math.min(index, results.length - 1));
    index += 1;
    if (result === undefined) {
      throw new Error('The fetch stub was called with no queued result.');
    }
    return result instanceof Error
      ? Promise.reject(result)
      : Promise.resolve(result.clone());
  });
  return new SessionManager<User, { username: string }>({
    client: createApiClient({
      baseUrl: 'https://api.example.test',
      fetch: fetchMock,
      retries: 0,
    }),
    mode: 'token',
    tokenStorageKey: 'access_token',
    tokenStorage: new MemoryTokenStorage(),
  });
}

/** Renders the session as text, so assertions read off the DOM. */
function SessionProbe(): React.ReactNode {
  const { status, user, isAuthenticated, isLoading } = useSession<User>();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.username ?? 'none'}</span>
      <span data-testid="authenticated">{String(isAuthenticated)}</span>
      <span data-testid="loading">{String(isLoading)}</span>
    </div>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SessionProvider', () => {
  it('refreshes on mount and renders the signed in user', async () => {
    const manager = managerWith([jsonResponse(ALICE)]);

    render(
      <SessionProvider manager={manager as unknown as AnySessionManager}>
        <SessionProbe />
      </SessionProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });
    expect(screen.getByTestId('user').textContent).toBe('alice');
    expect(screen.getByTestId('authenticated').textContent).toBe('true');
    expect(screen.getByTestId('loading').textContent).toBe('false');
  });

  it('reports anonymous after a 401', async () => {
    const manager = managerWith([jsonResponse({ detail: 'nope' }, 401)]);

    render(
      <SessionProvider manager={manager as unknown as AnySessionManager}>
        <SessionProbe />
      </SessionProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('anonymous');
    });
    expect(screen.getByTestId('authenticated').textContent).toBe('false');
  });

  it('treats the unknown state as loading so no signed out UI flashes', () => {
    // Portfolio's useState(false) plus a mount effect renders one frame of
    // signed out UI. The distinct unknown status is what prevents that, so it
    // has to read as loading before the first fetch settles.
    const manager = managerWith([jsonResponse(ALICE)]);

    render(
      <SessionProvider manager={manager as unknown as AnySessionManager}>
        <SessionProbe />
      </SessionProvider>
    );

    expect(screen.getByTestId('loading').textContent).toBe('true');
    expect(screen.getByTestId('authenticated').textContent).toBe('false');
  });

  it('skips the mount refresh when asked', () => {
    const manager = managerWith([jsonResponse(ALICE)]);
    const refresh = vi.spyOn(manager, 'refresh');

    render(
      <SessionProvider
        manager={manager as unknown as AnySessionManager}
        refreshOnMount={false}
      >
        <SessionProbe />
      </SessionProvider>
    );

    expect(refresh).not.toHaveBeenCalled();
    expect(screen.getByTestId('status').textContent).toBe('unknown');
  });

  it('makes one request under StrictMode double mounting', async () => {
    // StrictMode runs effects twice in development, so the provider calls
    // refresh twice. The manager de-duplicates concurrent refreshes, so the
    // network must still see exactly one request. Asserting on the fetch count
    // rather than on refresh's return value is the point: refresh is async, so
    // each call returns its own wrapper promise even when both await the same
    // in flight work.
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(ALICE)));
    const manager = new SessionManager<User>({
      client: createApiClient({
        baseUrl: 'https://api.example.test',
        fetch: fetchMock,
        retries: 0,
      }),
      mode: 'cookie',
    });

    render(
      <StrictMode>
        <SessionProvider manager={manager as unknown as AnySessionManager}>
          <SessionProbe />
        </SessionProvider>
      </StrictMode>
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('useSessionManager', () => {
  it('throws outside a provider', () => {
    function Orphan(): React.ReactNode {
      useSessionManager();
      return null;
    }
    // React logs the error boundary trace; silence it for this expected throw.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {
      /* intentionally silent */
    });

    expect(() => render(<Orphan />)).toThrow(
      /useSessionManager must be used within a SessionProvider/
    );
    consoleError.mockRestore();
  });

  it('returns the manager that was provided', () => {
    const manager = managerWith([jsonResponse(ALICE)]);
    let seen: unknown;

    function Consumer(): React.ReactNode {
      seen = useSessionManager<User>();
      return null;
    }

    render(
      <SessionProvider
        manager={manager as unknown as AnySessionManager}
        refreshOnMount={false}
      >
        <Consumer />
      </SessionProvider>
    );

    expect(seen).toBe(manager);
  });
});

describe('useSessionState', () => {
  it('re-renders when the manager state changes', async () => {
    const manager = managerWith([jsonResponse(ALICE)]);

    function StateProbe(): React.ReactNode {
      const state = useSessionState<User>();
      return <span data-testid="status">{state.status}</span>;
    }

    render(
      <SessionProvider
        manager={manager as unknown as AnySessionManager}
        refreshOnMount={false}
      >
        <StateProbe />
      </SessionProvider>
    );

    expect(screen.getByTestId('status').textContent).toBe('unknown');

    await act(async () => {
      await manager.refresh();
    });

    expect(screen.getByTestId('status').textContent).toBe('authenticated');
  });
});

describe('useSession actions', () => {
  it('logs in and exposes the user', async () => {
    const manager = managerWith([
      jsonResponse({ access_token: 'tok', user: ALICE }),
    ]);
    let login: (credentials: { username: string }) => Promise<User | null>;

    function LoginProbe(): React.ReactNode {
      const session = useSession<User, { username: string }>();
      login = session.login;
      return <span data-testid="user">{session.user?.username ?? 'none'}</span>;
    }

    render(
      <SessionProvider
        manager={manager as unknown as AnySessionManager}
        refreshOnMount={false}
      >
        <LoginProbe />
      </SessionProvider>
    );

    await act(async () => {
      await login({ username: 'alice' });
    });

    expect(screen.getByTestId('user').textContent).toBe('alice');
  });

  it('logs out and clears the user', async () => {
    const manager = managerWith([new Response(null, { status: 204 })]);
    let logout: () => Promise<void>;

    function LogoutProbe(): React.ReactNode {
      const session = useSession<User>();
      logout = session.logout;
      return <span data-testid="status">{session.status}</span>;
    }

    render(
      <SessionProvider
        manager={manager as unknown as AnySessionManager}
        refreshOnMount={false}
      >
        <LogoutProbe />
      </SessionProvider>
    );

    act(() => {
      manager.setUser(ALICE);
    });
    expect(screen.getByTestId('status').textContent).toBe('authenticated');

    await act(async () => {
      await logout();
    });

    expect(screen.getByTestId('status').textContent).toBe('anonymous');
  });
});
