import { render, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthClient } from './auth-client.js';
import {
  VERIFY_EMAIL_PATH,
  type EmailVerificationOutcome,
} from './email-flows.js';
import {
  useEmailVerificationLink,
  type EmailVerificationLinkOptions,
  type EmailVerificationLinkState,
} from './react.js';

const LANDING = `https://app.example.test${VERIFY_EMAIL_PATH}?token=tok_123`;

type Confirm = AuthClient<unknown>['confirmEmailVerification'];

/**
 * A client stub carrying only the method the hook calls, which is all the hook
 * reads off it.
 */
function clientWith(confirm: Confirm): AuthClient<unknown> {
  return {
    confirmEmailVerification: confirm,
  } as unknown as AuthClient<unknown>;
}

/** A confirm that resolves the given outcome. */
function confirmAnswering(outcome: EmailVerificationOutcome) {
  return vi.fn<Confirm>(() => Promise.resolve(outcome));
}

/** Renders the outcome as JSON, so assertions read one node off the DOM. */
function Probe(options: EmailVerificationLinkOptions): React.ReactNode {
  const state = useEmailVerificationLink(options);
  return <span data-testid="state">{JSON.stringify(state)}</span>;
}

function mount(options: EmailVerificationLinkOptions, strict = false) {
  const element = <Probe {...options} />;
  return render(strict ? <StrictMode>{element}</StrictMode> : element);
}

/** Reads the reported state back off the rendered probe. */
function stateOf(container: HTMLElement): EmailVerificationLinkState {
  const text =
    container.querySelector('[data-testid="state"]')?.textContent ?? 'null';
  return JSON.parse(text) as EmailVerificationLinkState;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useEmailVerificationLink', () => {
  it('reports failed without a request when there is no client', async () => {
    const confirm = confirmAnswering({ ok: true, userId: 'u_1' });

    const { container } = mount({ client: null, url: LANDING });

    await waitFor(() => {
      expect(stateOf(container)).toEqual({ kind: 'failed' });
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('reports a link with no token', async () => {
    const confirm = confirmAnswering({ ok: true, userId: 'u_1' });

    const { container } = mount({
      client: clientWith(confirm),
      url: `https://app.example.test${VERIFY_EMAIL_PATH}`,
    });

    await waitFor(() => {
      expect(stateOf(container)).toEqual({ kind: 'missing-token' });
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('reports a blank token as missing', async () => {
    const confirm = confirmAnswering({ ok: true, userId: 'u_1' });

    const { container } = mount({
      client: clientWith(confirm),
      url: `https://app.example.test${VERIFY_EMAIL_PATH}?token=`,
    });

    await waitFor(() => {
      expect(stateOf(container)).toEqual({ kind: 'missing-token' });
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('does not spend a token meant for another flow', async () => {
    const confirm = confirmAnswering({ ok: true, userId: 'u_1' });

    const { container } = mount({
      client: clientWith(confirm),
      url: 'https://x.test/other?token=abc',
    });

    await waitFor(() => {
      expect(stateOf(container)).toEqual({ kind: 'missing-token' });
    });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('honours an expectedPath the caller chose', async () => {
    const confirm = confirmAnswering({ ok: true, userId: 'u_1' });

    const { container } = mount({
      client: clientWith(confirm),
      expectedPath: '/other',
      url: 'https://x.test/other?token=abc',
    });

    await waitFor(() => {
      expect(stateOf(container)).toEqual({ kind: 'confirmed' });
    });
    expect(confirm).toHaveBeenCalledWith({ token: 'abc' });
  });

  it('reports a confirmed address and re-reads the user once', async () => {
    const confirm = confirmAnswering({ ok: true, userId: 'u_1' });
    const onConfirmed = vi.fn();

    const { container } = mount({
      client: clientWith(confirm),
      url: LANDING,
      onConfirmed,
    });

    await waitFor(() => {
      expect(stateOf(container)).toEqual({ kind: 'confirmed' });
    });
    expect(confirm).toHaveBeenCalledWith({ token: 'tok_123' });
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  it('confirms without an onConfirmed handler', async () => {
    const confirm = confirmAnswering({ ok: true, userId: null });

    const { container } = mount({ client: clientWith(confirm), url: LANDING });

    await waitFor(() => {
      expect(stateOf(container)).toEqual({ kind: 'confirmed' });
    });
  });

  it("passes the server's own sentence through a refusal verbatim", async () => {
    const confirm = confirmAnswering({
      ok: false,
      reason: 'invalid-link',
      code: 'INVALID_LINK',
      message: 'This link has expired. Request a new one.',
      retryAfter: undefined,
    });
    const onConfirmed = vi.fn();

    const { container } = mount({
      client: clientWith(confirm),
      url: LANDING,
      onConfirmed,
    });

    await waitFor(() => {
      expect(stateOf(container)).toEqual({
        kind: 'refused',
        reason: 'invalid-link',
        message: 'This link has expired. Request a new one.',
      });
    });
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it('reports a rate limit as a refusal with its own reason', async () => {
    const confirm = confirmAnswering({
      ok: false,
      reason: 'rate-limited',
      code: 'RATE_LIMITED',
      message: 'Too many attempts. Try again in a minute.',
      retryAfter: 60,
    });

    const { container } = mount({ client: clientWith(confirm), url: LANDING });

    await waitFor(() => {
      expect(stateOf(container)).toEqual({
        kind: 'refused',
        reason: 'rate-limited',
        message: 'Too many attempts. Try again in a minute.',
      });
    });
  });

  it('reports failed for a rejected request rather than rejecting', async () => {
    const confirm = vi.fn<Confirm>(() =>
      Promise.reject(new TypeError('failed to fetch'))
    );

    const { container } = mount({ client: clientWith(confirm), url: LANDING });

    await waitFor(() => {
      expect(stateOf(container)).toEqual({ kind: 'failed' });
    });
  });

  it('reports failed for a request that threw synchronously', async () => {
    const confirm = vi.fn<Confirm>(() => {
      throw new Error('boom');
    });

    const { container } = mount({ client: clientWith(confirm), url: LANDING });

    await waitFor(() => {
      expect(stateOf(container)).toEqual({ kind: 'failed' });
    });
  });

  it('spends the token exactly once under StrictMode, which mounts twice', async () => {
    const confirm = confirmAnswering({ ok: true, userId: 'u_1' });
    const onConfirmed = vi.fn();

    const { container } = mount(
      { client: clientWith(confirm), url: LANDING, onConfirmed },
      true
    );

    await waitFor(() => {
      expect(stateOf(container)).toEqual({ kind: 'confirmed' });
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onConfirmed).toHaveBeenCalledTimes(1);
  });

  it('spends the token once across re-renders', async () => {
    const confirm = confirmAnswering({ ok: true, userId: 'u_1' });
    const options = { client: clientWith(confirm), url: LANDING };

    const { rerender } = render(<Probe {...options} />);
    rerender(<Probe {...options} />);
    rerender(<Probe {...options} />);

    await waitFor(() => {
      expect(confirm).toHaveBeenCalledTimes(1);
    });
  });
});
