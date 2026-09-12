import { act, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { AuthState } from './auth-client.js';
import { AuthProvider, useAuth, type AnyAuthClient } from './react.js';

interface User {
  id: string;
  email: string;
}

const ALICE: User = { id: 'u_1', email: 'alice@example.test' };

/**
 * The smallest client the provider and `useAuth` can run against: the three
 * members `AuthProvider` and `useAuthState` call unconditionally, plus whichever
 * flow the component under test exercises.
 */
function minimalStub(overrides: Record<string, unknown> = {}): {
  client: AnyAuthClient;
  setState: (next: Partial<AuthState<User>>) => void;
  logout: ReturnType<typeof vi.fn>;
} {
  let state: AuthState<User> = {
    status: 'authenticated',
    user: ALICE,
    hasAccessToken: true,
    error: null,
    sessionEnded: null,
    pendingMfa: null,
  };
  const listeners = new Set<() => void>();
  const logout = vi.fn(() => {
    state = {
      ...state,
      status: 'anonymous',
      user: null,
      hasAccessToken: false,
    };
    for (const listener of listeners) {
      listener();
    }
    return Promise.resolve();
  });

  const stub = {
    initialize: vi.fn(() => Promise.resolve(null)),
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    logout,
    ...overrides,
  };

  return {
    client: stub as unknown as AnyAuthClient,
    setState: (next) => {
      state = { ...state, ...next };
      for (const listener of listeners) {
        listener();
      }
    },
    logout,
  };
}

describe('useAuth lazy method binding', () => {
  it('renders against a stub with only initialize, getState, subscribe and logout', async () => {
    function SignOut(): React.ReactNode {
      const { status, logout } = useAuth<User>();
      return (
        <div>
          <span data-testid="status">{status}</span>
          <button
            type="button"
            onClick={() => {
              void logout();
            }}
          >
            sign out
          </button>
        </div>
      );
    }

    const { client, logout } = minimalStub();

    render(
      <AuthProvider client={client}>
        <SignOut />
      </AuthProvider>
    );

    expect(screen.getByTestId('status').textContent).toBe('authenticated');

    await act(async () => {
      screen.getByRole('button', { name: 'sign out' }).click();
      await Promise.resolve();
    });

    expect(logout).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('anonymous');
    });
  });

  it('exposes every method on the result without reading the missing ones', () => {
    let keys: string[] = [];
    function Inspect(): React.ReactNode {
      keys = Object.keys(useAuth<User>());
      return null;
    }
    const { client } = minimalStub();

    render(
      <AuthProvider client={client}>
        <Inspect />
      </AuthProvider>
    );

    expect(keys).toContain('logout');
    expect(keys).toContain('renamePasskey');
    expect(keys).toContain('getAccessToken');
  });

  it('keeps each method referentially stable across re-renders and state changes', async () => {
    const logouts: unknown[] = [];
    const setUsers: unknown[] = [];
    function Capture(): React.ReactNode {
      const { logout, setUser, status } = useAuth<User>();
      logouts.push(logout);
      setUsers.push(setUser);
      return <span data-testid="status">{status}</span>;
    }
    const { client, setState } = minimalStub({ setUser: vi.fn() });

    const { rerender } = render(
      <AuthProvider client={client}>
        <Capture />
      </AuthProvider>
    );

    rerender(
      <AuthProvider client={client}>
        <Capture />
      </AuthProvider>
    );

    act(() => {
      setState({ status: 'loading' });
    });

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('loading');
    });

    expect(logouts.length).toBeGreaterThan(2);
    expect(new Set(logouts).size).toBe(1);
    expect(new Set(setUsers).size).toBe(1);
  });

  it('throws naming the method when a missing one is read', () => {
    let read: (() => void) | null = null;
    function ReadMissing(): React.ReactNode {
      const auth = useAuth<User>();
      read = () => {
        void auth.renamePasskey('c_1', 'Laptop');
      };
      return null;
    }
    const { client } = minimalStub();

    render(
      <AuthProvider client={client}>
        <ReadMissing />
      </AuthProvider>
    );

    expect(read).not.toBeNull();
    expect(read).toThrow(
      /useAuth: the auth client does not implement renamePasskey\(\)/
    );
    expect(read).toThrow(/only the methods the component under test calls/);
  });

  it('does not leak a wrapper between two clients', () => {
    const seen: unknown[] = [];
    function Capture(): React.ReactNode {
      seen.push(useAuth<User>().logout);
      return null;
    }
    const first = minimalStub();
    const second = minimalStub();

    const { rerender } = render(
      <AuthProvider client={first.client}>
        <Capture />
      </AuthProvider>
    );
    rerender(
      <AuthProvider client={second.client}>
        <Capture />
      </AuthProvider>
    );

    expect(new Set(seen).size).toBe(2);
  });

  it('calls a bound method with the client as the receiver', async () => {
    const stub = minimalStub();
    function CallLogout(): React.ReactNode {
      const { logout } = useAuth<User>();
      return (
        <button
          type="button"
          onClick={() => {
            void logout();
          }}
        >
          go
        </button>
      );
    }

    render(
      <AuthProvider client={stub.client}>
        <CallLogout />
      </AuthProvider>
    );

    await act(async () => {
      screen.getByRole('button', { name: 'go' }).click();
      await Promise.resolve();
    });

    expect(stub.logout.mock.instances[0]).toBe(stub.client);
  });
});
