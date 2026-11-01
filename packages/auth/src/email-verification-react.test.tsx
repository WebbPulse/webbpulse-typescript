import { act, render, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthClient } from './auth-client.js';
import {
  VERIFY_EMAIL_PATH,
  type EmailRequestOutcome,
  type EmailVerificationOutcome,
} from './email-flows.js';
import {
  EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS,
  EMAIL_VERIFICATION_WATCH_INTERVAL_MS,
  useEmailVerificationLink,
  useEmailVerificationResend,
  useEmailVerificationWatch,
  type EmailVerificationLinkOptions,
  type EmailVerificationLinkState,
  type EmailVerificationWatchOptions,
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

/** Lets a timer or event's promises settle inside React's act. */
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useEmailVerificationWatch', () => {
  type RefreshSession = AuthClient<unknown>['refreshSession'];
  let visibility: DocumentVisibilityState;

  function setup(overrides: Partial<EmailVerificationWatchOptions> = {}) {
    const refreshSession = vi.fn<RefreshSession>(() => Promise.resolve(null));
    const isVerified = vi.fn(() => Promise.resolve(true));
    const client = { refreshSession } as unknown as AuthClient<unknown>;
    const view = renderHook(() => {
      useEmailVerificationWatch({ client, isVerified, ...overrides });
    });
    return { refreshSession, isVerified, ...view };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    visibility = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(
      () => visibility
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('checks on the interval, not on mount, and refreshes once verified', async () => {
    const { isVerified, refreshSession } = setup();

    await advance(0);
    expect(isVerified).not.toHaveBeenCalled();

    await advance(EMAIL_VERIFICATION_WATCH_INTERVAL_MS);
    expect(isVerified).toHaveBeenCalledTimes(1);
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it('leaves the session alone until the address is verified', async () => {
    const isVerified = vi.fn(() => Promise.resolve(false));
    const { refreshSession } = setup({ isVerified });

    await advance(EMAIL_VERIFICATION_WATCH_INTERVAL_MS);

    expect(isVerified).toHaveBeenCalledTimes(1);
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it('checks when the window regains focus or the page becomes visible', async () => {
    const { isVerified } = setup();

    window.dispatchEvent(new Event('focus'));
    await advance(0);
    expect(isVerified).toHaveBeenCalledTimes(1);

    document.dispatchEvent(new Event('visibilitychange'));
    await advance(0);
    expect(isVerified).toHaveBeenCalledTimes(2);
  });

  it('skips a hidden page', async () => {
    visibility = 'hidden';
    const { isVerified } = setup();

    await advance(EMAIL_VERIFICATION_WATCH_INTERVAL_MS);

    expect(isVerified).not.toHaveBeenCalled();
  });

  it('never runs two checks at once', async () => {
    let answer: (verified: boolean) => void = () => undefined;
    const isVerified = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        })
    );
    setup({ isVerified });

    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('focus'));
    await advance(0);
    expect(isVerified).toHaveBeenCalledTimes(1);

    answer(false);
    await advance(0);
    window.dispatchEvent(new Event('focus'));
    await advance(0);
    expect(isVerified).toHaveBeenCalledTimes(2);
  });

  it('keeps watching after a failed check', async () => {
    const isVerified = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(true);
    const { refreshSession } = setup({ isVerified });

    await advance(EMAIL_VERIFICATION_WATCH_INTERVAL_MS);
    expect(refreshSession).not.toHaveBeenCalled();

    await advance(EMAIL_VERIFICATION_WATCH_INTERVAL_MS);
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it('honours a custom interval', async () => {
    const { isVerified } = setup({ intervalMs: 1000 });

    await advance(1000);

    expect(isVerified).toHaveBeenCalledTimes(1);
  });

  it('watches nothing when disabled or without a client', async () => {
    const { isVerified } = setup({ enabled: false });
    const orphan = vi.fn(() => Promise.resolve(true));
    renderHook(() => {
      useEmailVerificationWatch({ client: null, isVerified: orphan });
    });

    window.dispatchEvent(new Event('focus'));
    await advance(EMAIL_VERIFICATION_WATCH_INTERVAL_MS);

    expect(isVerified).not.toHaveBeenCalled();
    expect(orphan).not.toHaveBeenCalled();
  });

  it('stops on unmount', async () => {
    const { isVerified, unmount } = setup();

    unmount();
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new Event('visibilitychange'));
    await advance(EMAIL_VERIFICATION_WATCH_INTERVAL_MS);

    expect(isVerified).not.toHaveBeenCalled();
  });
});

describe('useEmailVerificationResend', () => {
  type RequestVerification = AuthClient<unknown>['requestEmailVerification'];
  const SENT: EmailRequestOutcome = { ok: true, detail: 'Sent.' };
  const LIMITED: EmailRequestOutcome = {
    ok: false,
    reason: 'rate-limited',
    code: undefined,
    message: 'Slow down.',
    retryAfter: undefined,
  };

  function setup(request: RequestVerification, cooldownSeconds?: number) {
    const client = {
      requestEmailVerification: request,
    } as unknown as AuthClient<unknown>;
    return renderHook(() =>
      useEmailVerificationResend({
        client,
        ...(cooldownSeconds === undefined ? {} : { cooldownSeconds }),
      })
    );
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends, then refuses until the cooldown has run out', async () => {
    const request = vi.fn<RequestVerification>(() => Promise.resolve(SENT));
    const { result } = setup(request);

    let first: EmailRequestOutcome | null = null;
    await act(async () => {
      first = await result.current.send('a@b.test');
    });
    expect(first).toBe(SENT);
    expect(request).toHaveBeenCalledWith({ email: 'a@b.test' });
    expect(result.current.remaining).toBe(
      EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS
    );

    let second: EmailRequestOutcome | null = SENT;
    await act(async () => {
      second = await result.current.send('a@b.test');
    });
    expect(second).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);

    for (let i = 0; i < EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS; i += 1) {
      await advance(1000);
    }
    expect(result.current.remaining).toBe(0);

    await act(async () => {
      await result.current.send('a@b.test');
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('honours a custom cooldown', async () => {
    const { result } = setup(() => Promise.resolve(SENT), 5);

    await act(async () => {
      await result.current.send('a@b.test');
    });
    expect(result.current.remaining).toBe(5);

    await advance(1000);
    expect(result.current.remaining).toBe(4);
  });

  it('starts no cooldown on a refusal, and hands it back', async () => {
    const { result } = setup(() => Promise.resolve(LIMITED));

    let outcome: EmailRequestOutcome | null = null;
    await act(async () => {
      outcome = await result.current.send('a@b.test');
    });

    expect(outcome).toBe(LIMITED);
    expect(result.current.remaining).toBe(0);
  });

  it('guards the request in flight and reports it', async () => {
    let answer: (outcome: EmailRequestOutcome) => void = () => undefined;
    const request = vi.fn<RequestVerification>(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        })
    );
    const { result } = setup(request);

    let pending: Promise<EmailRequestOutcome | null> = Promise.resolve(null);
    act(() => {
      pending = result.current.send('a@b.test');
    });
    expect(result.current.sending).toBe(true);

    let overlapping: EmailRequestOutcome | null = SENT;
    await act(async () => {
      overlapping = await result.current.send('a@b.test');
    });
    expect(overlapping).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);

    await act(async () => {
      answer(SENT);
      await pending;
    });
    expect(result.current.sending).toBe(false);
  });

  it('rejects a network failure and allows another try', async () => {
    const request = vi
      .fn<RequestVerification>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(SENT);
    const { result } = setup(request);

    await act(async () => {
      await expect(result.current.send('a@b.test')).rejects.toThrow('offline');
    });
    expect(result.current.sending).toBe(false);
    expect(result.current.remaining).toBe(0);

    await act(async () => {
      await result.current.send('a@b.test');
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('resolves null without a client', async () => {
    const { result } = renderHook(() =>
      useEmailVerificationResend({ client: null })
    );

    await expect(result.current.send('a@b.test')).resolves.toBeNull();
    expect(result.current.sending).toBe(false);
  });

  it('keeps send stable across renders', async () => {
    const { result, rerender } = setup(() => Promise.resolve(SENT));
    const before = result.current.send;

    await act(async () => {
      await result.current.send('a@b.test');
    });
    rerender();

    expect(result.current.send).toBe(before);
  });
});
