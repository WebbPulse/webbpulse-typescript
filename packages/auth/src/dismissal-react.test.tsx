import { act, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthState } from './auth-client.js';
import {
  AuthProvider,
  DISMISSAL_STORAGE_PREFIX,
  useDismissedUntilSignIn,
  type AnyAuthClient,
} from './react.js';

/** A stub client whose state a test moves by hand, notifying subscribers. */
function stubClient(initial: Partial<AuthState<unknown>>): {
  client: AnyAuthClient;
  move: (next: Partial<AuthState<unknown>>) => void;
} {
  let state: AuthState<unknown> = {
    status: 'unknown',
    user: null,
    hasAccessToken: false,
    error: null,
    sessionEnded: null,
    pendingMfa: null,
    settled: false,
    ...initial,
  };
  const listeners = new Set<() => void>();
  const client = {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as AnyAuthClient;
  const move = (next: Partial<AuthState<unknown>>): void => {
    state = { ...state, ...next };
    act(() => {
      for (const listener of listeners) {
        listener();
      }
    });
  };
  return { client, move };
}

const SIGNED_IN: Partial<AuthState<unknown>> = {
  status: 'authenticated',
  hasAccessToken: true,
  settled: true,
};

const SIGNED_OUT: Partial<AuthState<unknown>> = {
  status: 'anonymous',
  hasAccessToken: false,
  settled: true,
};

/** Draws the notice unless dismissed, with a button that dismisses it. */
function Notice({ storageKey }: { storageKey: string }): React.ReactNode {
  const { dismissed, dismiss } = useDismissedUntilSignIn(storageKey);
  if (dismissed) {
    return <span>hidden</span>;
  }
  return (
    <button type="button" onClick={dismiss}>
      dismiss
    </button>
  );
}

function renderNotice(client: AnyAuthClient, storageKey: string): void {
  render(
    <StrictMode>
      <AuthProvider client={client} initializeOnMount={false}>
        <Notice storageKey={storageKey} />
      </AuthProvider>
    </StrictMode>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('useDismissedUntilSignIn', () => {
  it('shows the notice until dismissed and stores the flag under the prefix', () => {
    const { client } = stubClient(SIGNED_IN);
    renderNotice(client, 'banner-a');

    act(() => {
      screen.getByRole('button', { name: 'dismiss' }).click();
    });

    expect(screen.getByText('hidden')).not.toBeNull();
    expect(sessionStorage.getItem(`${DISMISSAL_STORAGE_PREFIX}banner-a`)).toBe(
      '1'
    );
  });

  it('keeps a dismissal across a remount inside the same session', () => {
    sessionStorage.setItem(`${DISMISSAL_STORAGE_PREFIX}banner-b`, '1');
    const { client } = stubClient(SIGNED_IN);
    renderNotice(client, 'banner-b');

    expect(screen.getByText('hidden')).not.toBeNull();
  });

  it('keeps the flag while the session is still unknown', () => {
    sessionStorage.setItem(`${DISMISSAL_STORAGE_PREFIX}banner-c`, '1');
    const { client, move } = stubClient({ status: 'loading', settled: false });
    renderNotice(client, 'banner-c');

    expect(screen.getByText('hidden')).not.toBeNull();
    move(SIGNED_IN);

    expect(screen.getByText('hidden')).not.toBeNull();
    expect(sessionStorage.getItem(`${DISMISSAL_STORAGE_PREFIX}banner-c`)).toBe(
      '1'
    );
  });

  it('keeps the flag through a token refresh on a live session', () => {
    const { client, move } = stubClient(SIGNED_IN);
    renderNotice(client, 'banner-d');
    act(() => {
      screen.getByRole('button', { name: 'dismiss' }).click();
    });

    move({ status: 'loading', hasAccessToken: true });
    move(SIGNED_IN);

    expect(screen.getByText('hidden')).not.toBeNull();
  });

  it('shows the notice again after a sign-out and a new sign-in', () => {
    const { client, move } = stubClient(SIGNED_IN);
    renderNotice(client, 'banner-e');
    act(() => {
      screen.getByRole('button', { name: 'dismiss' }).click();
    });

    move(SIGNED_OUT);
    expect(
      sessionStorage.getItem(`${DISMISSAL_STORAGE_PREFIX}banner-e`)
    ).toBeNull();
    move({ status: 'loading', hasAccessToken: false });
    move(SIGNED_IN);

    expect(screen.getByRole('button', { name: 'dismiss' })).not.toBeNull();
  });

  it('clears a stale flag when the first settle finds no session', () => {
    sessionStorage.setItem(`${DISMISSAL_STORAGE_PREFIX}banner-f`, '1');
    const { client, move } = stubClient({ settled: false });
    renderNotice(client, 'banner-f');

    move(SIGNED_OUT);

    expect(
      sessionStorage.getItem(`${DISMISSAL_STORAGE_PREFIX}banner-f`)
    ).toBeNull();
  });

  it('falls back to memory when storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    const { client, move } = stubClient(SIGNED_IN);
    renderNotice(client, 'banner-g');

    expect(screen.getByRole('button', { name: 'dismiss' })).not.toBeNull();
    act(() => {
      screen.getByRole('button', { name: 'dismiss' }).click();
    });
    expect(screen.getByText('hidden')).not.toBeNull();

    move(SIGNED_OUT);
    move(SIGNED_IN);

    expect(screen.getByRole('button', { name: 'dismiss' })).not.toBeNull();
  });

  it('keeps a memory fallback dismissal across a remount', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const { client } = stubClient(SIGNED_IN);
    const first = render(
      <AuthProvider client={client} initializeOnMount={false}>
        <Notice storageKey="banner-h" />
      </AuthProvider>
    );
    act(() => {
      screen.getByRole('button', { name: 'dismiss' }).click();
    });
    first.unmount();

    renderNotice(client, 'banner-h');

    expect(screen.getByText('hidden')).not.toBeNull();
  });
});
