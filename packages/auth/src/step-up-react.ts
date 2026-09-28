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
