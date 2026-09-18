import { usePolledQuery } from '@webbpulse/api-client/react';
import { render, screen, waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { AuthState } from './auth-client.js';
import { AuthProvider, useQueryAuth, type AnyAuthClient } from './react.js';

interface User {
  id: string;
}

function stubClient(waitForToken: () => Promise<string | null>): AnyAuthClient {
  const state: AuthState<User> = {
    status: 'authenticated',
    user: { id: 'u_1' },
    hasAccessToken: true,
    error: null,
    sessionEnded: null,
    pendingMfa: null,
    settled: true,
  };
  return {
    initialize: vi.fn(() => Promise.resolve(null)),
    getState: () => state,
    subscribe: () => () => undefined,
    waitForToken,
  } as unknown as AnyAuthClient;
}

describe('useQueryAuth', () => {
  it('delegates waitForToken to the client from context', async () => {
    const waitForToken = vi.fn(() => Promise.resolve('token-1'));
    let seen: string | null = 'unset';

    function Probe(): React.ReactNode {
      const auth = useQueryAuth();
      return (
        <button
          onClick={() => {
            void auth.waitForToken().then((token) => {
              seen = token;
            });
          }}
        >
          go
        </button>
      );
    }

    render(
      <AuthProvider client={stubClient(waitForToken)}>
        <Probe />
      </AuthProvider>
    );

    screen.getByRole('button').click();
    await waitFor(() => {
      expect(seen).toBe('token-1');
    });
    expect(waitForToken).toHaveBeenCalledTimes(1);
  });

  it('stays referentially stable across renders', async () => {
    const identities = new Set<unknown>();

    function Probe(): React.ReactNode {
      const auth = useQueryAuth();
      identities.add(auth);
      const renders = useRef(0);
      renders.current += 1;
      return <span data-testid="renders">{renders.current}</span>;
    }

    const client = stubClient(() => Promise.resolve(null));
    const { rerender } = render(
      <AuthProvider client={client}>
        <Probe />
      </AuthProvider>
    );
    rerender(
      <AuthProvider client={client}>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('renders').textContent).toBe('2');
    });
    expect(identities.size).toBe(1);
  });

  it('holds the first poll until the token has settled', async () => {
    let release: (token: string | null) => void = () => undefined;
    const gate = new Promise<string | null>((resolve) => {
      release = resolve;
    });
    const fetcher = vi.fn(() => Promise.resolve('data'));

    function Probe(): React.ReactNode {
      const auth = useQueryAuth();
      const { data } = usePolledQuery(fetcher, { auth });
      return <span data-testid="data">{data ?? 'none'}</span>;
    }

    render(
      <AuthProvider client={stubClient(() => gate)}>
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('data').textContent).toBe('none');
    });
    expect(fetcher).not.toHaveBeenCalled();

    release('token-1');
    await waitFor(() => {
      expect(screen.getByTestId('data').textContent).toBe('data');
    });
  });
});
