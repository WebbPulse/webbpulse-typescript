import { render, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OAuthCallbackResult } from './oauth.js';
import { useOAuthCallback, type OAuthCallbackHandler } from './react.js';

const navigate = globalThis.history.replaceState.bind(globalThis.history);

let replaceState: ReturnType<typeof vi.fn>;

function landOn(search: string): void {
  navigate(null, '', `/login${search}`);
}

beforeEach(() => {
  landOn('');
  replaceState = vi.fn();
  vi.spyOn(globalThis.history, 'replaceState').mockImplementation(replaceState);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function Harness({ onCallback }: { onCallback: OAuthCallbackHandler }) {
  useOAuthCallback(onCallback);
  return null;
}

function mount(onCallback: OAuthCallbackHandler, strict = false) {
  const element = <Harness onCallback={onCallback} />;
  return render(strict ? <StrictMode>{element}</StrictMode> : element);
}

describe('useOAuthCallback', () => {
  it('does nothing on an ordinary visit', async () => {
    const onCallback = vi.fn();

    mount(onCallback);
    await waitFor(() => {
      expect(replaceState).not.toHaveBeenCalled();
    });

    expect(onCallback).not.toHaveBeenCalled();
  });

  it('reports a completed sign in', async () => {
    const onCallback = vi.fn();
    landOn('?oauth=1');

    mount(onCallback);

    await waitFor(() => {
      expect(onCallback).toHaveBeenCalledWith({ kind: 'signed-in' });
    });
  });

  it('reports an MFA challenge with its ticket', async () => {
    const onCallback = vi.fn();
    landOn('?mfa_ticket=t_123');

    mount(onCallback);

    await waitFor(() => {
      expect(onCallback).toHaveBeenCalledWith({
        kind: 'mfa-required',
        ticket: 't_123',
      });
    });
  });

  it('reports a provider that was linked', async () => {
    const onCallback = vi.fn();
    landOn('?oauth_linked=1');

    mount(onCallback);

    await waitFor(() => {
      expect(onCallback).toHaveBeenCalledWith({ kind: 'linked' });
    });
  });

  it('reports a refusal', async () => {
    const onCallback = vi.fn();
    landOn('?oauth_error=OAUTH_CANCELLED');

    mount(onCallback);

    await waitFor(() => {
      expect(onCallback).toHaveBeenCalledWith({
        kind: 'error',
        code: 'OAUTH_CANCELLED',
        rawCode: 'OAUTH_CANCELLED',
      });
    });
  });

  it('strips the single-use parameters and keeps the rest', async () => {
    const onCallback = vi.fn();
    landOn('?next=%2Fgarage&mfa_ticket=t_123');

    mount(onCallback);

    await waitFor(() => {
      expect(replaceState).toHaveBeenCalledTimes(1);
    });
    expect(replaceState).toHaveBeenCalledWith(
      null,
      '',
      `${globalThis.location.origin}/login?next=%2Fgarage`
    );
  });

  it('does not touch the URL on an ordinary visit', async () => {
    const onCallback = vi.fn();
    landOn('?next=%2Fgarage');

    mount(onCallback);
    await waitFor(() => {
      expect(onCallback).not.toHaveBeenCalled();
    });

    expect(replaceState).not.toHaveBeenCalled();
  });

  it('reads once under StrictMode, which mounts effects twice', async () => {
    const onCallback = vi.fn();
    landOn('?mfa_ticket=t_123');

    mount(onCallback, true);

    await waitFor(() => {
      expect(onCallback).toHaveBeenCalledTimes(1);
    });
    expect(replaceState).toHaveBeenCalledTimes(1);
  });

  it('awaits an async handler without rejecting the effect', async () => {
    const seen: OAuthCallbackResult[] = [];
    const onCallback = vi.fn((result: OAuthCallbackResult) => {
      seen.push(result);
      return Promise.resolve();
    });
    landOn('?oauth=1');

    mount(onCallback);

    await waitFor(() => {
      expect(seen).toEqual([{ kind: 'signed-in' }]);
    });
  });

  it('calls the latest handler, so a caller need not memoise it', async () => {
    const first = vi.fn();
    const second = vi.fn();
    landOn('?oauth=1');

    const { rerender } = render(<Harness onCallback={first} />);
    rerender(<Harness onCallback={second} />);

    await waitFor(() => {
      expect(first).toHaveBeenCalledTimes(1);
    });
    expect(second).not.toHaveBeenCalled();
  });
});
