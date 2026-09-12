import { act, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { createAuthClient, type AuthClient } from './auth-client.js';
import { AuthSessionEndedError } from './errors.js';
import {
  AuthProvider,
  useAuthState,
  useSessionEnded,
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

function tokenResponse(token = 'a1'): Response {
  return jsonResponse({ access_token: token, expires_in: 600 });
}

function unauthorizedResponse(): Response {
  return jsonResponse(
    {
      success: false,
      status: 401,
      message: 'Session expired.',
      request_id: 'r',
    },
    401
  );
}

function serverErrorResponse(): Response {
  return jsonResponse(
    {
      success: false,
      status: 500,
      message: 'Upstream exploded.',
      request_id: 'r',
    },
    500
  );
}

function clientWith(responses: (call: number) => Response): {
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
    loadUser: () => Promise.resolve(ALICE),
    clientOptions: { fetch: fetchMock, retries: 0 },
  });
  return { client, fetchMock };
}

/** Renders the fields under test as text, so assertions read off the DOM. */
function Probe(): React.ReactNode {
  const { status, error } = useAuthState<User>();
  const sessionEnded = useSessionEnded();
  return (
    <div>
      <span data-testid="status">{status}</span>
      <span data-testid="error">{error === null ? 'none' : error.name}</span>
      <span data-testid="ended">
        {sessionEnded === null ? 'none' : sessionEnded.reason}
      </span>
    </div>
  );
}

describe('sessionEnded on AuthState', () => {
  it('is set by an ordinary 401 expiry and fires the prop exactly once', async () => {
    const { client } = clientWith((call) =>
      call === 0 ? tokenResponse() : unauthorizedResponse()
    );
    const onSessionEnded = vi.fn();

    render(
      <AuthProvider
        client={client as unknown as AnyAuthClient}
        onSessionEnded={onSessionEnded}
      >
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });
    expect(screen.getByTestId('ended').textContent).toBe('none');

    await act(async () => {
      await client.refresh();
    });

    expect(screen.getByTestId('ended').textContent).toBe('refresh-failed');
    expect(screen.getByTestId('error').textContent).toBe('none');
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
    const received: unknown = onSessionEnded.mock.calls[0]?.[0];
    expect(received).toBeInstanceOf(AuthSessionEndedError);
    expect((received as AuthSessionEndedError).reason).toBe('refresh-failed');
  });

  it('is set alongside error by a non-401 failure', async () => {
    const { client } = clientWith((call) =>
      call === 0 ? tokenResponse() : serverErrorResponse()
    );
    const onSessionEnded = vi.fn();

    render(
      <AuthProvider
        client={client as unknown as AnyAuthClient}
        onSessionEnded={onSessionEnded}
      >
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });

    await act(async () => {
      await client.refresh();
    });

    expect(screen.getByTestId('ended').textContent).toBe('refresh-failed');
    expect(screen.getByTestId('error').textContent).toBe(
      'AuthSessionEndedError'
    );
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('is cleared by a later successful login', async () => {
    const { client } = clientWith((call) => {
      if (call === 0) {
        return tokenResponse();
      }
      if (call === 1) {
        return unauthorizedResponse();
      }
      return tokenResponse('a2');
    });

    render(
      <AuthProvider client={client as unknown as AnyAuthClient}>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });

    await act(async () => {
      await client.refresh();
    });
    expect(screen.getByTestId('ended').textContent).toBe('refresh-failed');

    await act(async () => {
      await client.login({
        email: ALICE.email,
        password: 'correct horse battery staple',
      });
    });

    expect(screen.getByTestId('status').textContent).toBe('authenticated');
    expect(screen.getByTestId('ended').textContent).toBe('none');
  });

  it('is cleared by a later successful initialize', async () => {
    const { client } = clientWith((call) =>
      call === 0 ? tokenResponse() : tokenResponse('a2')
    );

    render(
      <AuthProvider
        client={client as unknown as AnyAuthClient}
        initializeOnMount={false}
      >
        <Probe />
      </AuthProvider>
    );

    await act(async () => {
      await client.logout();
    });
    expect(screen.getByTestId('ended').textContent).toBe('logged-out');

    await act(async () => {
      await client.initialize();
    });

    expect(screen.getByTestId('status').textContent).toBe('authenticated');
    expect(screen.getByTestId('ended').textContent).toBe('none');
  });

  it('stays null when the startup refresh found no cookie', async () => {
    const { client } = clientWith(() => unauthorizedResponse());
    const onSessionEnded = vi.fn();

    render(
      <AuthProvider
        client={client as unknown as AnyAuthClient}
        onSessionEnded={onSessionEnded}
      >
        <Probe />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('anonymous');
    });
    expect(screen.getByTestId('ended').textContent).toBe('none');
    expect(onSessionEnded).not.toHaveBeenCalled();
  });

  it('fires the prop once under StrictMode double mounting', async () => {
    const { client } = clientWith((call) =>
      call === 0 ? tokenResponse() : unauthorizedResponse()
    );
    const onSessionEnded = vi.fn();

    render(
      <StrictMode>
        <AuthProvider
          client={client as unknown as AnyAuthClient}
          onSessionEnded={onSessionEnded}
        >
          <Probe />
        </AuthProvider>
      </StrictMode>
    );
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });

    await act(async () => {
      await client.refresh();
    });

    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  /**
   * StrictMode's double mount runs the fan-out effect twice against an ending
   * that is already in state, which is the case the dep array alone does not
   * cover because the snapshot never changes between the two runs.
   */
  it('fires the prop once when the session had already ended before mount', async () => {
    const { client } = clientWith((call) =>
      call === 0 ? tokenResponse() : unauthorizedResponse()
    );
    const onSessionEnded = vi.fn();

    await act(async () => {
      await client.login({ email: ALICE.email, password: 'pw' });
    });
    await act(async () => {
      await client.refresh();
    });
    expect(client.getState().sessionEnded).not.toBeNull();

    render(
      <StrictMode>
        <AuthProvider
          client={client as unknown as AnyAuthClient}
          initializeOnMount={false}
          onSessionEnded={onSessionEnded}
        >
          <Probe />
        </AuthProvider>
      </StrictMode>
    );

    await waitFor(() => {
      expect(onSessionEnded).toHaveBeenCalledTimes(1);
    });
    expect(onSessionEnded).toHaveBeenCalledTimes(1);
  });

  it('fires again for a second, distinct ending', async () => {
    const { client } = clientWith((call) => {
      if (call === 0 || call === 2) {
        return tokenResponse();
      }
      return unauthorizedResponse();
    });
    const onSessionEnded = vi.fn();

    render(
      <AuthProvider
        client={client as unknown as AnyAuthClient}
        onSessionEnded={onSessionEnded}
      >
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });

    await act(async () => {
      await client.refresh();
    });
    expect(onSessionEnded).toHaveBeenCalledTimes(1);

    await act(async () => {
      await client.login({ email: ALICE.email, password: 'pw' });
    });
    expect(screen.getByTestId('ended').textContent).toBe('none');

    await act(async () => {
      await client.refresh();
    });

    expect(onSessionEnded).toHaveBeenCalledTimes(2);
  });

  it('fires the prop and the constructor callback together', async () => {
    const fromOption = vi.fn();
    let calls = 0;
    const fetchMock = vi.fn(() => {
      const response = calls === 0 ? tokenResponse() : unauthorizedResponse();
      calls += 1;
      return Promise.resolve(response);
    });
    const client = createAuthClient<User>({
      baseUrl: 'https://api.example.test',
      disableProactiveRefresh: true,
      loadUser: () => Promise.resolve(ALICE),
      onSessionEnded: fromOption,
      clientOptions: { fetch: fetchMock, retries: 0 },
    });
    const fromProp = vi.fn();

    render(
      <AuthProvider
        client={client as unknown as AnyAuthClient}
        onSessionEnded={fromProp}
      >
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });

    await act(async () => {
      await client.refresh();
    });

    expect(fromOption).toHaveBeenCalledTimes(1);
    expect(fromProp).toHaveBeenCalledTimes(1);
  });

  it('renders with no prop given', async () => {
    const { client } = clientWith((call) =>
      call === 0 ? tokenResponse() : unauthorizedResponse()
    );

    render(
      <AuthProvider client={client as unknown as AnyAuthClient}>
        <Probe />
      </AuthProvider>
    );
    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('authenticated');
    });

    await act(async () => {
      await client.refresh();
    });

    expect(screen.getByTestId('ended').textContent).toBe('refresh-failed');
  });
});
