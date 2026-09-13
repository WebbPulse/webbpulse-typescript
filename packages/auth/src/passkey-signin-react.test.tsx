import { render, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  usePasskeySignInSupport,
  type PasskeySignInSupport,
  type PasskeySignInSupportOptions,
} from './react.js';

type Availability = 'available' | 'unavailable' | 'unknown';

/** Puts a WebAuthn capable `PublicKeyCredential` on the global. */
function browserWithPasskeys(conditional: boolean | Error = false): void {
  vi.stubGlobal('PublicKeyCredential', {
    isConditionalMediationAvailable: vi.fn(() =>
      conditional instanceof Error
        ? Promise.reject(conditional)
        : Promise.resolve(conditional)
    ),
  });
}

/** Removes `PublicKeyCredential`, which is how a browser without WebAuthn reads. */
function browserWithoutPasskeys(): void {
  vi.stubGlobal('PublicKeyCredential', undefined);
}

/** A probe that resolves the given answer, so a test can assert it was not called. */
function probeAnswering(availability: Availability) {
  return vi.fn<() => Promise<Availability>>(() =>
    Promise.resolve(availability)
  );
}

/** Renders the support flags as text, so assertions read off the DOM. */
function Probe(options: PasskeySignInSupportOptions): React.ReactNode {
  const { offered, conditional } = usePasskeySignInSupport(options);
  return (
    <div>
      <span data-testid="offered">{String(offered)}</span>
      <span data-testid="conditional">{String(conditional)}</span>
    </div>
  );
}

function mount(options: PasskeySignInSupportOptions, strict = false) {
  const element = <Probe {...options} />;
  return render(strict ? <StrictMode>{element}</StrictMode> : element);
}

/** Reads both flags off the rendered probe. */
function support(container: HTMLElement): PasskeySignInSupport {
  const read = (id: string): boolean =>
    container.querySelector(`[data-testid="${id}"]`)?.textContent === 'true';
  return { offered: read('offered'), conditional: read('conditional') };
}

beforeEach(() => {
  browserWithPasskeys();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('usePasskeySignInSupport', () => {
  it('offers nothing in a browser without WebAuthn', async () => {
    browserWithoutPasskeys();
    const probe = probeAnswering('available');

    const { container } = mount({ probe });

    await waitFor(() => {
      expect(support(container)).toEqual({
        offered: false,
        conditional: false,
      });
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it('offers the button when the browser and the deployment both say yes', async () => {
    browserWithPasskeys(true);
    const probe = probeAnswering('available');

    const { container } = mount({ probe });

    await waitFor(() => {
      expect(support(container)).toEqual({ offered: true, conditional: true });
    });
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('offers the button without autofill when conditional mediation is absent', async () => {
    vi.stubGlobal('PublicKeyCredential', {});
    const probe = probeAnswering('available');

    const { container } = mount({ probe });

    await waitFor(() => {
      expect(support(container)).toEqual({ offered: true, conditional: false });
    });
  });

  it('offers the button without autofill when the browser answers false', async () => {
    browserWithPasskeys(false);
    const probe = probeAnswering('available');

    const { container } = mount({ probe });

    await waitFor(() => {
      expect(support(container)).toEqual({ offered: true, conditional: false });
    });
  });

  it('offers the button without autofill when the capability read throws', async () => {
    browserWithPasskeys(new Error('nope'));
    const probe = probeAnswering('available');

    const { container } = mount({ probe });

    await waitFor(() => {
      expect(support(container)).toEqual({ offered: true, conditional: false });
    });
  });

  it('offers nothing when the deployment has passwordless off', async () => {
    browserWithPasskeys(true);
    const probe = probeAnswering('unavailable');

    const { container } = mount({ probe });

    await waitFor(() => {
      expect(probe).toHaveBeenCalledTimes(1);
    });
    expect(support(container)).toEqual({ offered: false, conditional: false });
  });

  it('offers nothing when the read could not be made', async () => {
    browserWithPasskeys(true);
    const probe = probeAnswering('unknown');

    const { container } = mount({ probe });

    await waitFor(() => {
      expect(probe).toHaveBeenCalledTimes(1);
    });
    expect(support(container)).toEqual({ offered: false, conditional: false });
  });

  it('does not ask when disabled', async () => {
    const probe = probeAnswering('available');

    const { container } = mount({ probe, enabled: false });

    await waitFor(() => {
      expect(support(container)).toEqual({
        offered: false,
        conditional: false,
      });
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it('asks once enabled turns on', async () => {
    browserWithPasskeys(true);
    const probe = probeAnswering('available');

    const { container, rerender } = render(
      <Probe probe={probe} enabled={false} />
    );
    expect(probe).not.toHaveBeenCalled();

    rerender(<Probe probe={probe} enabled />);

    await waitFor(() => {
      expect(support(container)).toEqual({ offered: true, conditional: true });
    });
  });

  it('sets no state after unmounting mid probe', async () => {
    browserWithPasskeys(true);
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let release: ((availability: Availability) => void) | undefined;
    const probe = vi.fn<() => Promise<Availability>>(
      () =>
        new Promise<Availability>((resolve) => {
          release = resolve;
        })
    );

    const { unmount } = mount({ probe });
    await waitFor(() => {
      expect(probe).toHaveBeenCalledTimes(1);
    });
    unmount();
    release?.('available');
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).not.toHaveBeenCalled();
  });

  it('probes once on mount, so a changed probe does not re-ask', async () => {
    browserWithPasskeys(true);
    const first = probeAnswering('available');
    const second = probeAnswering('unavailable');

    const { container, rerender } = render(<Probe probe={first} />);
    rerender(<Probe probe={second} />);

    await waitFor(() => {
      expect(support(container)).toEqual({ offered: true, conditional: true });
    });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('does not re-probe when only the probe identity changed', async () => {
    browserWithPasskeys(true);
    const probe = probeAnswering('available');

    const { rerender } = render(<Probe probe={probe} />);
    await waitFor(() => {
      expect(probe).toHaveBeenCalledTimes(1);
    });

    rerender(<Probe probe={probeAnswering('available')} />);
    rerender(<Probe probe={probeAnswering('available')} />);

    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('settles the same way under StrictMode, which mounts effects twice', async () => {
    browserWithPasskeys(true);
    const probe = probeAnswering('available');

    const { container } = mount({ probe }, true);

    await waitFor(() => {
      expect(support(container)).toEqual({ offered: true, conditional: true });
    });
  });

  it('offers nothing under StrictMode when the deployment says no', async () => {
    browserWithPasskeys(true);
    const probe = probeAnswering('unavailable');

    const { container } = mount({ probe }, true);

    await waitFor(() => {
      expect(probe).toHaveBeenCalled();
    });
    expect(support(container)).toEqual({ offered: false, conditional: false });
  });
});
