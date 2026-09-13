import { act, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthClient } from '../auth-client.js';
import type {
  RecoveryCodesOutcome,
  TotpActivationOutcome,
  TotpDisableOutcome,
  TotpEnrolmentOutcome,
} from '../mfa.js';
import { useTotpPanel, type TotpPanelOptions } from './totp-panel.js';

interface TotpStub {
  enrolTotp: ReturnType<typeof vi.fn>;
  activateTotp: ReturnType<typeof vi.fn>;
  disableTotp: ReturnType<typeof vi.fn>;
  regenerateRecoveryCodes: ReturnType<typeof vi.fn>;
}

const SECRET = 'JBSWY3DPEHPK3PXP';
const URI = 'otpauth://totp/WebbPulse:alice?secret=JBSWY3DPEHPK3PXP';

/** An enrolment the server started, carrying the seed it issued once. */
function enrolled(): TotpEnrolmentOutcome {
  return { ok: true, secret: SECRET, provisioningUri: URI };
}

/** An enrolment refused because a factor is already on. */
function alreadyEnabled(message: string): TotpEnrolmentOutcome {
  return { ok: false, reason: 'already-enabled', code: undefined, message };
}

/** A refusal saying the deployment has MFA switched off. */
function mfaUnavailable(message: string): TotpEnrolmentOutcome {
  return { ok: false, reason: 'unavailable', code: undefined, message };
}

/** An activation the server accepted, carrying the recovery codes. */
function activated(recoveryCodes: string[]): TotpActivationOutcome {
  return { ok: true, recoveryCodes };
}

/** A refused one-time code. */
function badCode(message: string): TotpActivationOutcome {
  return { ok: false, reason: 'invalid-code', code: undefined, message };
}

/** A stub client exposing only the four TOTP calls the panel makes. */
function stubClient(): TotpStub {
  return {
    enrolTotp: vi.fn(() => Promise.resolve(enrolled())),
    activateTotp: vi.fn(() =>
      Promise.resolve(activated(['aaaa-1111', 'bbbb-2222']))
    ),
    disableTotp: vi.fn(() =>
      Promise.resolve({ ok: true } as TotpDisableOutcome)
    ),
    regenerateRecoveryCodes: vi.fn(() =>
      Promise.resolve({
        ok: true,
        recoveryCodes: ['cccc-3333'],
      } as RecoveryCodesOutcome)
    ),
  };
}

let handle: ReturnType<typeof useTotpPanel> | null = null;

/** Renders the panel state as text, so assertions read off the DOM. */
function TotpProbe(options: TotpPanelOptions): React.ReactNode {
  const totp = useTotpPanel(options);
  handle = totp;
  return (
    <div>
      <span data-testid="factor">{totp.factor}</span>
      <span data-testid="step">{totp.step.kind}</span>
      <span data-testid="secret">
        {totp.step.kind === 'scanning' ? totp.step.secret : 'none'}
      </span>
      <span data-testid="uri">
        {totp.step.kind === 'scanning' ? totp.step.provisioningUri : 'none'}
      </span>
      <span data-testid="codes">
        {totp.step.kind === 'codes' ? totp.step.codes.join(',') : 'none'}
      </span>
      <span data-testid="prompt">{totp.prompt}</span>
      <span data-testid="code">{totp.code}</span>
      <span data-testid="busy">{String(totp.busy)}</span>
      <span data-testid="error">{totp.error ?? 'none'}</span>
      <span data-testid="notice">{totp.notice ?? 'none'}</span>
      <span data-testid="unavailable">{String(totp.unavailable)}</span>
    </div>
  );
}

/** Mounts the probe against a stub. */
function mount(
  stub: TotpStub,
  options: Omit<TotpPanelOptions, 'client'> = {}
): void {
  render(
    <TotpProbe {...options} client={stub as unknown as AuthClient<unknown>} />
  );
}

/** The panel returned by the most recent render. */
function panel(): ReturnType<typeof useTotpPanel> {
  if (handle === null) {
    throw new Error('The probe has not rendered.');
  }
  return handle;
}

/** Drives an enrolment through to the scanning step. */
async function toScanning(): Promise<void> {
  await act(async () => {
    await panel().enrol();
  });
}

afterEach(() => {
  handle = null;
  vi.restoreAllMocks();
});

describe('useTotpPanel', () => {
  it('makes no call on mount', () => {
    const stub = stubClient();

    mount(stub);

    expect(stub.enrolTotp).not.toHaveBeenCalled();
    expect(stub.activateTotp).not.toHaveBeenCalled();
    expect(stub.disableTotp).not.toHaveBeenCalled();
    expect(stub.regenerateRecoveryCodes).not.toHaveBeenCalled();
    expect(screen.getByTestId('step').textContent).toBe('idle');
    expect(screen.getByTestId('factor').textContent).toBe('unknown');
  });

  it('takes the factor state the caller already knows', () => {
    const stub = stubClient();

    mount(stub, { factor: 'enabled' });

    expect(screen.getByTestId('factor').textContent).toBe('enabled');
  });

  it('moves to scanning with the seed and asks for the activation code', async () => {
    const stub = stubClient();

    mount(stub);
    await toScanning();

    expect(screen.getByTestId('step').textContent).toBe('scanning');
    expect(screen.getByTestId('secret').textContent).toBe(SECRET);
    expect(screen.getByTestId('uri').textContent).toBe(URI);
    expect(screen.getByTestId('prompt').textContent).toBe('activate');
    expect(screen.getByTestId('busy').textContent).toBe('false');
  });

  it('marks the factor enabled when enrolment says one is already on', async () => {
    const stub = stubClient();
    stub.enrolTotp.mockResolvedValue(
      alreadyEnabled('An authenticator app is already set up.')
    );

    mount(stub);
    await toScanning();

    expect(screen.getByTestId('factor').textContent).toBe('enabled');
    expect(screen.getByTestId('step').textContent).toBe('idle');
    expect(screen.getByTestId('error').textContent).toBe(
      'An authenticator app is already set up.'
    );
  });

  it('marks the panel unavailable when the deployment has MFA off', async () => {
    const stub = stubClient();
    stub.enrolTotp.mockResolvedValue(
      mfaUnavailable('Two-factor authentication is switched off.')
    );

    mount(stub);
    await toScanning();

    expect(screen.getByTestId('unavailable').textContent).toBe('true');
    expect(screen.getByTestId('error').textContent).toBe(
      'Two-factor authentication is switched off.'
    );
  });

  it('activates, shows the recovery codes and reports the change', async () => {
    const stub = stubClient();
    const onChanged = vi.fn();

    mount(stub, { onChanged });
    await toScanning();
    act(() => {
      panel().setCode(' 123456 ');
    });
    await act(async () => {
      await panel().activate();
    });

    expect(stub.activateTotp).toHaveBeenCalledWith({ code: '123456' });
    expect(screen.getByTestId('step').textContent).toBe('codes');
    expect(screen.getByTestId('codes').textContent).toBe('aaaa-1111,bbbb-2222');
    expect(screen.getByTestId('factor').textContent).toBe('enabled');
    expect(screen.getByTestId('prompt').textContent).toBe('none');
    expect(screen.getByTestId('code').textContent).toBe('');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('leaves the step alone when the activation code is refused', async () => {
    const stub = stubClient();
    stub.activateTotp.mockResolvedValue(badCode('That code is not right.'));
    const onChanged = vi.fn();

    mount(stub, { onChanged });
    await toScanning();
    act(() => {
      panel().setCode('000000');
    });
    await act(async () => {
      await panel().activate();
    });

    expect(screen.getByTestId('step').textContent).toBe('scanning');
    expect(screen.getByTestId('secret').textContent).toBe(SECRET);
    expect(screen.getByTestId('prompt').textContent).toBe('activate');
    expect(screen.getByTestId('error').textContent).toBe(
      'That code is not right.'
    );
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('disables the factor, returns to idle and shows the disabled message', async () => {
    const stub = stubClient();
    const onChanged = vi.fn();

    mount(stub, {
      factor: 'enabled',
      onChanged,
      messages: { disabled: 'Authenticator app removed.' },
    });
    act(() => {
      panel().ask('disable');
    });
    act(() => {
      panel().setCode('654321');
    });
    await act(async () => {
      await panel().disable();
    });

    expect(stub.disableTotp).toHaveBeenCalledWith({ code: '654321' });
    expect(screen.getByTestId('factor').textContent).toBe('disabled');
    expect(screen.getByTestId('step').textContent).toBe('idle');
    expect(screen.getByTestId('prompt').textContent).toBe('none');
    expect(screen.getByTestId('notice').textContent).toBe(
      'Authenticator app removed.'
    );
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('replaces the recovery codes without reporting a factor change', async () => {
    const stub = stubClient();
    const onChanged = vi.fn();

    mount(stub, { factor: 'enabled', onChanged });
    act(() => {
      panel().ask('regenerate');
    });
    act(() => {
      panel().setCode('111111');
    });
    await act(async () => {
      await panel().regenerate();
    });

    expect(stub.regenerateRecoveryCodes).toHaveBeenCalledWith({
      code: '111111',
    });
    expect(screen.getByTestId('step').textContent).toBe('codes');
    expect(screen.getByTestId('codes').textContent).toBe('cccc-3333');
    expect(screen.getByTestId('prompt').textContent).toBe('none');
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('opens a prompt and clears the code and banners', async () => {
    const stub = stubClient();
    stub.enrolTotp.mockResolvedValue(mfaUnavailable('Off.'));

    mount(stub, { factor: 'enabled' });
    await toScanning();
    expect(screen.getByTestId('error').textContent).toBe('Off.');

    act(() => {
      panel().setCode('999');
    });
    act(() => {
      panel().ask('disable');
    });

    expect(screen.getByTestId('prompt').textContent).toBe('disable');
    expect(screen.getByTestId('code').textContent).toBe('');
    expect(screen.getByTestId('error').textContent).toBe('none');
  });

  it('resets the step, the prompt, the code and the error', async () => {
    const stub = stubClient();

    mount(stub);
    await toScanning();
    act(() => {
      panel().setCode('123');
    });
    act(() => {
      panel().reset();
    });

    expect(screen.getByTestId('step').textContent).toBe('idle');
    expect(screen.getByTestId('prompt').textContent).toBe('none');
    expect(screen.getByTestId('code').textContent).toBe('');
    expect(screen.getByTestId('error').textContent).toBe('none');
  });

  it('leaves the recovery codes screen with the saved message', async () => {
    const stub = stubClient();

    mount(stub, { messages: { saved: 'Recovery codes stored.' } });
    await toScanning();
    await act(async () => {
      await panel().activate();
    });
    expect(screen.getByTestId('step').textContent).toBe('codes');

    act(() => {
      panel().acknowledgeCodes();
    });

    expect(screen.getByTestId('step').textContent).toBe('idle');
    expect(screen.getByTestId('notice').textContent).toBe(
      'Recovery codes stored.'
    );
  });

  it('leaves the codes screen with no notice when no saved message is given', async () => {
    const stub = stubClient();

    mount(stub);
    await toScanning();
    await act(async () => {
      await panel().activate();
    });
    act(() => {
      panel().acknowledgeCodes();
    });

    expect(screen.getByTestId('step').textContent).toBe('idle');
    expect(screen.getByTestId('notice').textContent).toBe('none');
  });

  it('clears both banners on dismiss', async () => {
    const stub = stubClient();
    stub.enrolTotp.mockResolvedValue(mfaUnavailable('Off.'));

    mount(stub);
    await toScanning();
    expect(screen.getByTestId('error').textContent).toBe('Off.');

    act(() => {
      panel().dismiss();
    });

    expect(screen.getByTestId('error').textContent).toBe('none');
    expect(screen.getByTestId('notice').textContent).toBe('none');
  });

  it('makes no call on mount under StrictMode double mounting', () => {
    const stub = stubClient();

    render(
      <StrictMode>
        <TotpProbe client={stub as unknown as AuthClient<unknown>} />
      </StrictMode>
    );

    expect(stub.enrolTotp).not.toHaveBeenCalled();
    expect(screen.getByTestId('step').textContent).toBe('idle');
  });
});
