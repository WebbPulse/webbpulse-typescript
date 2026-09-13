/**
 * The TOTP settings panel's state machine: enrol, activate, disable and
 * regenerate, with the one-time code field and the recovery codes screen both
 * products show between them.
 *
 * There is no load leg. No route reports whether a factor is on, on purpose, so
 * the panel is told by its caller and otherwise reports only what it has seen
 * since it mounted.
 */

import { useCallback, useMemo, useState } from 'react';

import type { AuthClient } from '../auth-client.js';
import type {
  MfaRefusal,
  RecoveryCodesOutcome,
  TotpActivationOutcome,
  TotpDisableOutcome,
  TotpEnrolmentOutcome,
} from '../mfa.js';

/**
 * Whether a factor is on. `'unknown'` is the honest starting answer, since no
 * route reports it and a panel that guessed would be wrong half the time.
 */
export type FactorState = 'unknown' | 'enabled' | 'disabled';

/**
 * Where the enrolment has got to. `'scanning'` holds the seed the server issued
 * once; `'codes'` holds the recovery codes, also issued once, which is why they
 * live in the step rather than being re-read.
 */
export type TotpStep =
  | { kind: 'idle' }
  | { kind: 'scanning'; secret: string; provisioningUri: string }
  | { kind: 'codes'; codes: string[] };

/** Which one-time code the panel is currently asking for. */
export type TotpPrompt = 'none' | 'activate' | 'disable' | 'regenerate';

/** The success copy the TOTP panel shows. */
export interface TotpPanelMessages {
  /** After the factor is turned off. */
  disabled?: string;
  /** After the recovery codes screen is dismissed. */
  saved?: string;
}

/** Options for {@link useTotpPanel}. */
export interface TotpPanelOptions {
  /** The client to call. */
  client: AuthClient<unknown>;
  /**
   * Whether a factor is already on, when the caller knows from the user record.
   * Defaults to `'unknown'`.
   */
  factor?: FactorState;
  /**
   * Called when the factor is turned on or off, so a caller holding the user
   * record can re-read it. Not called by a regenerate, which changes no flag.
   */
  onChanged?: () => void;
  /** The success copy. Refusals always use the server's own sentence. */
  messages?: TotpPanelMessages;
}

/** What {@link useTotpPanel} returns. */
export interface TotpPanel {
  /** Whether a factor is on, as far as this panel has been told. */
  factor: FactorState;
  /** Where the enrolment has got to. */
  step: TotpStep;
  /** Which one-time code is being asked for. */
  prompt: TotpPrompt;
  /** The code field's value. */
  code: string;
  /** Replaces the code field's value. */
  setCode: (code: string) => void;
  /** True while a call is in flight. */
  busy: boolean;
  /** The server's own sentence for the last refusal, or null. */
  error: string | null;
  /** The sentence for the last success, or null. */
  notice: string | null;
  /** Whether the deployment has MFA switched off. */
  unavailable: boolean;
  /** Starts an enrolment, moving to `'scanning'` with the seed. */
  enrol: () => Promise<void>;
  /** Activates the pending enrolment with {@link TotpPanel.code}. */
  activate: () => Promise<void>;
  /** Turns the factor off with {@link TotpPanel.code}. */
  disable: () => Promise<void>;
  /** Replaces the recovery codes with {@link TotpPanel.code}. */
  regenerate: () => Promise<void>;
  /** Opens one of the code prompts, clearing the banners. */
  ask: (prompt: Exclude<TotpPrompt, 'none'>) => void;
  /** Closes whatever is open and clears the code and the error. */
  reset: () => void;
  /** Leaves the recovery codes screen, recording that they were saved. */
  acknowledgeCodes: () => void;
  /** Clears `error` and `notice`. */
  dismiss: () => void;
}

/** Whether a refusal means the deployment has MFA switched off. */
function isUnavailable(refusal: MfaRefusal): boolean {
  return refusal.reason === 'unavailable';
}

/**
 * The TOTP settings panel, headless. Renders nothing: the QR code, the recovery
 * codes screen and the code field stay in the product.
 *
 * The four calls share one busy, error and notice envelope. A refused code
 * leaves the step where it was, so the user retries against the same seed
 * rather than starting an enrolment over.
 *
 * @example
 * ```tsx
 * const totp = useTotpPanel({ client, factor: user.totpEnabled ? 'enabled' : 'disabled' });
 * if (totp.step.kind === 'scanning') return <Qr uri={totp.step.provisioningUri} />;
 * ```
 */
export function useTotpPanel(options: TotpPanelOptions): TotpPanel {
  const { client, onChanged } = options;
  const [seen, setSeen] = useState<FactorState | null>(null);
  const [step, setStep] = useState<TotpStep>({ kind: 'idle' });
  const [prompt, setPrompt] = useState<TotpPrompt>('none');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  const factor = seen ?? options.factor ?? 'unknown';

  const run = useCallback(async <T>(call: () => Promise<T>): Promise<T> => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      return await call();
    } finally {
      setBusy(false);
    }
  }, []);

  const refuse = useCallback((refusal: MfaRefusal): void => {
    setError(refusal.message);
    if (isUnavailable(refusal)) {
      setUnavailable(true);
    }
  }, []);

  const enrol = useCallback(async (): Promise<void> => {
    const outcome: TotpEnrolmentOutcome = await run(() => client.enrolTotp());
    if (outcome.ok) {
      setStep({
        kind: 'scanning',
        secret: outcome.secret,
        provisioningUri: outcome.provisioningUri,
      });
      setPrompt('activate');
      return;
    }
    if (outcome.reason === 'already-enabled') {
      setSeen('enabled');
    }
    refuse(outcome);
  }, [client, run, refuse]);

  const activate = useCallback(async (): Promise<void> => {
    const outcome: TotpActivationOutcome = await run(() =>
      client.activateTotp({ code: code.trim() })
    );
    if (outcome.ok) {
      setSeen('enabled');
      setStep({ kind: 'codes', codes: outcome.recoveryCodes });
      setPrompt('none');
      setCode('');
      onChanged?.();
      return;
    }
    refuse(outcome);
  }, [client, code, run, refuse, onChanged]);

  const disable = useCallback(async (): Promise<void> => {
    const outcome: TotpDisableOutcome = await run(() =>
      client.disableTotp({ code: code.trim() })
    );
    if (outcome.ok) {
      setSeen('disabled');
      setStep({ kind: 'idle' });
      setPrompt('none');
      setCode('');
      setNotice(options.messages?.disabled ?? null);
      onChanged?.();
      return;
    }
    refuse(outcome);
  }, [client, code, run, refuse, onChanged, options.messages?.disabled]);

  const regenerate = useCallback(async (): Promise<void> => {
    const outcome: RecoveryCodesOutcome = await run(() =>
      client.regenerateRecoveryCodes({ code: code.trim() })
    );
    if (outcome.ok) {
      setStep({ kind: 'codes', codes: outcome.recoveryCodes });
      setPrompt('none');
      setCode('');
      return;
    }
    refuse(outcome);
  }, [client, code, run, refuse]);

  const ask = useCallback((next: Exclude<TotpPrompt, 'none'>): void => {
    setPrompt(next);
    setCode('');
    setError(null);
    setNotice(null);
  }, []);

  const reset = useCallback((): void => {
    setStep({ kind: 'idle' });
    setPrompt('none');
    setCode('');
    setError(null);
  }, []);

  const savedMessage = options.messages?.saved;

  const acknowledgeCodes = useCallback((): void => {
    setStep({ kind: 'idle' });
    setNotice(savedMessage ?? null);
  }, [savedMessage]);

  const dismiss = useCallback((): void => {
    setError(null);
    setNotice(null);
  }, []);

  return useMemo(
    () => ({
      factor,
      step,
      prompt,
      code,
      setCode,
      busy,
      error,
      notice,
      unavailable,
      enrol,
      activate,
      disable,
      regenerate,
      ask,
      reset,
      acknowledgeCodes,
      dismiss,
    }),
    [
      factor,
      step,
      prompt,
      code,
      busy,
      error,
      notice,
      unavailable,
      enrol,
      activate,
      disable,
      regenerate,
      ask,
      reset,
      acknowledgeCodes,
      dismiss,
    ]
  );
}
