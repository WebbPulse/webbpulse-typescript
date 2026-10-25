/**
 * The headless step-up gate: a request the server refuses with
 * `STEP_UP_REQUIRED` parks while the product renders a prompt, and replays once
 * the person has re-authenticated.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  isStepUpRequired,
  type StepUpRequiredError,
} from '@webbpulse/api-client';

import type { AuthClient } from './auth-client.js';
import { StepUpCancelledError } from './errors.js';
import type { PasswordStepUpOutcome, StepUpOutcome } from './mfa.js';
import type { PasskeyStepUpOutcome } from './passkeys.js';

/** How the person re-authenticates: a password, a TOTP or recovery code, or a passkey. */
export type StepUpMethod =
  | { password: string }
  | { code: string }
  | { passkey: true; signal?: AbortSignal };

/**
 * Why a {@link StepUpGate.submit} did not succeed: the refusal the step-up
 * call settled with, or the error it threw. Both carry a renderable `message`.
 */
export type StepUpFailure =
  | Exclude<
      StepUpOutcome | PasswordStepUpOutcome | PasskeyStepUpOutcome,
      { ok: true }
    >
  | Error;

/** What `useStepUp` returns. State and callbacks only; the product draws the prompt. */
export interface StepUpGate {
  /** True while at least one wrapped request is waiting on a step-up. */
  open: boolean;
  /**
   * The strictest `max_age`, in seconds, among the waiting requests' challenges,
   * or null when none carried one.
   */
  maxAge: number | null;
  /** True while a {@link StepUpGate.submit} is in flight. */
  pending: boolean;
  /** Why the last submit failed, or null. Cleared by the next submit and on close. */
  error: StepUpFailure | null;
  /**
   * Re-authenticates with `method`. On success the prompt closes and every
   * waiting request is replayed once, its caller's promise settling with the
   * replay. Resolves true on success and false on a refusal or a throw, which
   * land in `error` with the prompt left open. Does nothing and resolves false
   * when no request is waiting or a submit is already in flight.
   */
  submit: (method: StepUpMethod) => Promise<boolean>;
  /**
   * Closes the prompt and rejects every waiting request with a
   * {@link StepUpCancelledError}.
   */
  cancel: () => void;
  /**
   * Wraps an async function so a `STEP_UP_REQUIRED` rejection opens the prompt
   * instead of reaching the caller. Any other outcome passes straight through.
   * Stable for the component's lifetime.
   */
  withStepUp: <TArgs extends unknown[], TResult>(
    fn: (...args: TArgs) => Promise<TResult>
  ) => (...args: TArgs) => Promise<TResult>;
}

interface Waiter {
  retry: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  challenge: StepUpRequiredError;
}

function stricter(
  current: number | null,
  next: number | undefined
): number | null {
  if (next === undefined) {
    return current;
  }
  return current === null ? next : Math.min(current, next);
}

/** The body of `useStepUp`, taking the client rather than reading context. */
export function useStepUpGate(client: AuthClient<unknown>): StepUpGate {
  const [open, setOpen] = useState(false);
  const [maxAge, setMaxAge] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<StepUpFailure | null>(null);

  const waiters = useRef<Waiter[]>([]);
  const submitting = useRef(false);
  const live = useRef(true);
  const clientRef = useRef(client);
  clientRef.current = client;

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      const abandoned = waiters.current;
      waiters.current = [];
      for (const waiter of abandoned) {
        waiter.reject(
          new StepUpCancelledError({
            message: 'The step-up prompt was unmounted.',
            cause: waiter.challenge,
          })
        );
      }
    };
  }, []);

  const withStepUp = useCallback(
    <TArgs extends unknown[], TResult>(
      fn: (...args: TArgs) => Promise<TResult>
    ) =>
      async (...args: TArgs): Promise<TResult> => {
        try {
          return await fn(...args);
        } catch (thrown) {
          if (!isStepUpRequired(thrown) || !live.current) {
            throw thrown;
          }
          return new Promise<TResult>((resolve, reject) => {
            const first = waiters.current.length === 0;
            waiters.current.push({
              retry: () => fn(...args),
              resolve: resolve as (value: unknown) => void,
              reject,
              challenge: thrown,
            });
            if (first) {
              setError(null);
              setMaxAge(thrown.maxAge ?? null);
              setOpen(true);
            } else {
              setMaxAge((current) => stricter(current, thrown.maxAge));
            }
          });
        }
      },
    []
  );

  const submit = useCallback(async (method: StepUpMethod): Promise<boolean> => {
    if (waiters.current.length === 0 || submitting.current) {
      return false;
    }
    submitting.current = true;
    setPending(true);
    setError(null);
    const auth = clientRef.current;
    let outcome: StepUpOutcome | PasswordStepUpOutcome | PasskeyStepUpOutcome;
    try {
      if ('passkey' in method) {
        outcome = await auth.stepUpWithPasskey(
          method.signal === undefined ? {} : { signal: method.signal }
        );
      } else {
        outcome = await auth.stepUp(method);
      }
    } catch (thrown) {
      submitting.current = false;
      if (live.current) {
        setPending(false);
        setError(thrown instanceof Error ? thrown : new Error(String(thrown)));
      }
      return false;
    }
    submitting.current = false;
    if (!live.current) {
      return outcome.ok;
    }
    setPending(false);
    if (!outcome.ok) {
      setError(outcome);
      return false;
    }
    const released = waiters.current;
    waiters.current = [];
    setOpen(false);
    setMaxAge(null);
    setError(null);
    for (const waiter of released) {
      waiter.retry().then(waiter.resolve, waiter.reject);
    }
    return true;
  }, []);

  const cancel = useCallback((): void => {
    const cancelled = waiters.current;
    waiters.current = [];
    setOpen(false);
    setMaxAge(null);
    setError(null);
    for (const waiter of cancelled) {
      waiter.reject(new StepUpCancelledError({ cause: waiter.challenge }));
    }
  }, []);

  return useMemo(
    () => ({ open, maxAge, pending, error, submit, cancel, withStepUp }),
    [open, maxAge, pending, error, submit, cancel, withStepUp]
  );
}

/** Where a proactive step-up stands: not started, waiting on a code, or proven. */
export type ProactiveStepUpStage = 'idle' | 'code' | 'done';

/** Options for the proactive mode of `useStepUp`. */
export interface ProactiveStepUpOptions {
  /** Selects the proactive mode. */
  mode: 'proactive';
  /**
   * Seconds a lockout lasts when the `rate-limited` refusal names no wait.
   * Defaults to 60.
   */
  lockoutFallbackSeconds?: number;
}

/** Options for the reactive mode of `useStepUp`, the default. */
export interface ReactiveStepUpOptions {
  /** Selects the reactive gate. */
  mode?: 'reactive';
}

/**
 * What `useStepUp({ mode: 'proactive' })` returns: a fresh proof of identity
 * asked for up front, before a sensitive call, rather than after the server
 * refuses one. State and callbacks only; the product draws the prompt.
 */
export interface ProactiveStepUp {
  /**
   * `idle` before any attempt, `code` once a passkey could not be used and a
   * code or password is wanted, `done` once proven or skipped.
   */
  stage: ProactiveStepUpStage;
  /** True while a {@link ProactiveStepUp.prove} is in flight. */
  pending: boolean;
  /**
   * Why the last attempt failed, or null. A dismissed passkey prompt, an
   * account with no passkeys and a browser without WebAuthn leave it null.
   * While {@link ProactiveStepUp.locked}, it is the `rate-limited` refusal.
   */
  error: StepUpFailure | null;
  /** True while a code or password lockout holds those methods shut. */
  locked: boolean;
  /**
   * Whole seconds left on the lockout, counting down each second, or 0 when
   * not locked.
   */
  lockedFor: number;
  /**
   * Proves identity with `method` and resolves true once proven, moving
   * `stage` to `done`. A passkey that cannot be used moves `stage` to `code`
   * instead of failing: no passkeys on the account, no WebAuthn in the
   * browser, a dismissed prompt, a refusal or a throw. A `rate-limited` code or
   * password refusal starts a lockout, during which a code or password resolves
   * false without a request. Resolves false while another attempt is in
   * flight.
   */
  prove: (method: StepUpMethod) => Promise<boolean>;
  /** Marks the step-up done with no proof, for an account with no second factor. */
  skip: () => void;
  /** Starts over at `idle`, for a prompt that was closed. A lockout stays. */
  reset: () => void;
}

const DEFAULT_LOCKOUT_FALLBACK_SECONDS = 60;

function lockoutSeconds(
  outcome: { retryAfter: number | undefined },
  fallback: number
): number {
  const { retryAfter } = outcome;
  return typeof retryAfter === 'number' && Number.isFinite(retryAfter)
    ? Math.max(0, retryAfter)
    : fallback;
}

/** The body of the proactive `useStepUp`, taking the client rather than reading context. */
export function useProactiveStepUpGate(
  client: AuthClient<unknown>,
  options: Omit<ProactiveStepUpOptions, 'mode'> = {}
): ProactiveStepUp {
  const fallback =
    options.lockoutFallbackSeconds ?? DEFAULT_LOCKOUT_FALLBACK_SECONDS;
  const [stage, setStage] = useState<ProactiveStepUpStage>('idle');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<StepUpFailure | null>(null);
  const [lockout, setLockout] = useState<{
    until: number;
    refusal: StepUpFailure;
  } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const proving = useRef(false);
  const live = useRef(true);
  const clientRef = useRef(client);
  clientRef.current = client;
  const fallbackRef = useRef(fallback);
  fallbackRef.current = fallback;
  const lockedUntil = useRef<number | null>(null);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  useEffect(() => {
    if (lockout === null) {
      return undefined;
    }
    const timer = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= lockout.until) {
        lockedUntil.current = null;
        setLockout(null);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [lockout]);

  const prove = useCallback(async (method: StepUpMethod): Promise<boolean> => {
    if (proving.current) {
      return false;
    }
    const passkey = 'passkey' in method;
    if (
      !passkey &&
      lockedUntil.current !== null &&
      Date.now() < lockedUntil.current
    ) {
      return false;
    }
    proving.current = true;
    setPending(true);
    setError(null);
    const auth = clientRef.current;
    let outcome: StepUpOutcome | PasswordStepUpOutcome | PasskeyStepUpOutcome;
    try {
      if (passkey) {
        outcome = await auth.stepUpWithPasskey(
          method.signal === undefined ? {} : { signal: method.signal }
        );
      } else {
        outcome = await auth.stepUp(method);
      }
    } catch (thrown) {
      proving.current = false;
      if (live.current) {
        setPending(false);
        setError(thrown instanceof Error ? thrown : new Error(String(thrown)));
        if (passkey) {
          setStage('code');
        }
      }
      return false;
    }
    proving.current = false;
    if (!live.current) {
      return outcome.ok;
    }
    setPending(false);
    if (outcome.ok) {
      setStage('done');
      return true;
    }
    if (passkey) {
      if (
        outcome.reason !== 'cancelled' &&
        outcome.reason !== 'no-passkeys' &&
        outcome.reason !== 'unsupported'
      ) {
        setError(outcome);
      }
      setStage('code');
      return false;
    }
    if (outcome.reason === 'rate-limited') {
      const current = Date.now();
      const until =
        current + lockoutSeconds(outcome, fallbackRef.current) * 1000;
      lockedUntil.current = until;
      setNow(current);
      setLockout({ until, refusal: outcome });
      return false;
    }
    setError(outcome);
    return false;
  }, []);

  const skip = useCallback((): void => {
    setError(null);
    setStage('done');
  }, []);

  const reset = useCallback((): void => {
    setStage('idle');
    setError(null);
  }, []);

  const remaining = lockout === null ? 0 : lockout.until - now;
  const locked = remaining > 0;
  const lockedFor = locked ? Math.ceil(remaining / 1000) : 0;
  const shown =
    locked && lockout !== null && stage !== 'done' ? lockout.refusal : error;

  return useMemo(
    () => ({
      stage,
      pending,
      error: shown,
      locked,
      lockedFor,
      prove,
      skip,
      reset,
    }),
    [stage, pending, shown, locked, lockedFor, prove, skip, reset]
  );
}
