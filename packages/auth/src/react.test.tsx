import { createApiClient } from '@webbpulse/api-client';
import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from './session.js';
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
    mode: 'cookie',
  });
}

/** Renders the session as text, so assertions read off the DOM. */
function SessionProbe(): React.ReactNode {
  const { status, user, isAuthenticated, isLoading, isBusy } =
    useSession<User>();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="user">{user?.username ?? 'none'}</span>
      <span data-testid="authenticated">{String(isAuthenticated)}</span>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="busy">{String(isBusy)}</span>
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
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

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

describe('useSession isLoading and isBusy', () => {
  it('leaves isLoading false once the session has settled, even mid-call', async () => {
    let release: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    const manager = new SessionManager<User, { username: string }>({
      client: createApiClient({
        baseUrl: 'https://api.example.test',
        fetch: fetchMock,
        retries: 0,
      }),
      mode: 'cookie',
    });

    render(
      <SessionProvider manager={manager as unknown as AnySessionManager}>
        <SessionProbe />
      </SessionProvider>
    );

    expect(screen.getByTestId('loading').textContent).toBe('true');

    await act(async () => {
      release?.(jsonResponse({ detail: 'nope' }, 401));
      await manager.refresh();
    });
    expect(screen.getByTestId('status').textContent).toBe('anonymous');
    expect(screen.getByTestId('loading').textContent).toBe('false');

    let login: Promise<unknown>;
    act(() => {
      login = manager.login({ username: 'alice' });
    });

    expect(screen.getByTestId('status').textContent).toBe('loading');
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('busy').textContent).toBe('true');

    await act(async () => {
      release?.(jsonResponse({ user: ALICE }));
      await login;
    });

    expect(screen.getByTestId('authenticated').textContent).toBe('true');
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('busy').textContent).toBe('false');
  });

  it('stays authenticated while a refresh is in flight on a live session', async () => {
    let release: ((response: Response) => void) | null = null;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })
    );
    const manager = new SessionManager<User>({
      client: createApiClient({
        baseUrl: 'https://api.example.test',
        fetch: fetchMock,
        retries: 0,
      }),
      mode: 'cookie',
    });

    render(
      <SessionProvider
        manager={manager as unknown as AnySessionManager}
        refreshOnMount={false}
      >
        <SessionProbe />
      </SessionProvider>
    );

    act(() => {
      manager.setUser(ALICE);
    });
    expect(screen.getByTestId('authenticated').textContent).toBe('true');

    let refresh: Promise<unknown>;
    act(() => {
      refresh = manager.refresh();
    });

    expect(screen.getByTestId('status').textContent).toBe('loading');
    expect(screen.getByTestId('busy').textContent).toBe('true');
    expect(screen.getByTestId('authenticated').textContent).toBe('true');

    await act(async () => {
      release?.(jsonResponse(ALICE));
      await refresh;
    });

    expect(screen.getByTestId('authenticated').textContent).toBe('true');
  });

  it('stays settled through a logout', async () => {
    const manager = managerWith([new Response(null, { status: 204 })]);

    render(
      <SessionProvider
        manager={manager as unknown as AnySessionManager}
        refreshOnMount={false}
      >
        <SessionProbe />
      </SessionProvider>
    );

    act(() => {
      manager.setUser(ALICE);
    });
    expect(screen.getByTestId('loading').textContent).toBe('false');

    await act(async () => {
      await manager.logout();
    });

    expect(screen.getByTestId('status').textContent).toBe('anonymous');
    expect(screen.getByTestId('loading').textContent).toBe('false');
    expect(screen.getByTestId('busy').textContent).toBe('false');
  });
});
