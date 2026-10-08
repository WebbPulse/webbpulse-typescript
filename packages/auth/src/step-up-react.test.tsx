import { ApiError, StepUpRequiredError } from '@webbpulse/api-client';
import { useMutationWithRefetch } from '@webbpulse/api-client/react';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi, type Mock } from 'vitest';

import type { AuthState } from './auth-client.js';
import { StepUpCancelledError } from './errors.js';
import { AuthProvider, useStepUp, type AnyAuthClient } from './react.js';

const STATE: AuthState<{ id: string }> = {
  status: 'authenticated',
  user: { id: 'u_1' },
  hasAccessToken: true,
  error: null,
  sessionEnded: null,
  pendingMfa: null,
  settled: true,
};

/** A step-up refusal as the transport classifies it. */
function challenge(maxAge?: number): StepUpRequiredError {
  return new StepUpRequiredError({
    status: 401,
    statusText: 'Unauthorized',
    url: 'https://api.example.test/workspaces/1',
    method: 'DELETE',
    body: {
      success: false,
      status: 401,
      message: 'Recent authentication required.',
      error_code: 'STEP_UP_REQUIRED',
      ...(maxAge === undefined ? {} : { max_age: maxAge }),
    },
    maxAge,
  });
}

interface StubClient {
  client: AnyAuthClient;
  stepUp: Mock;
  stepUpWithPasskey: Mock;
}

function stubClient(
  outcome: unknown = { ok: true, expiresIn: 600 }
): StubClient {
  const stepUp = vi.fn(() => Promise.resolve(outcome));
  const stepUpWithPasskey = vi.fn(() => Promise.resolve(outcome));
  const client = {
    initialize: vi.fn(() => Promise.resolve(null)),
    getState: () => STATE,
    subscribe: () => () => undefined,
    stepUp,
    stepUpWithPasskey,
  } as unknown as AnyAuthClient;
  return { client, stepUp, stepUpWithPasskey };
}

function wrapperFor(client: AnyAuthClient) {
  return function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return (
      <AuthProvider client={client} initializeOnMount={false}>
        {children}
      </AuthProvider>
    );
  };
}

/** A write that answers step-up required first and `value` after. */
function gatedWrite(value: string, maxAge?: number) {
  return vi
    .fn<(id: string) => Promise<string>>()
    .mockRejectedValueOnce(challenge(maxAge))
    .mockResolvedValue(value);
}

describe('useStepUp', () => {
  it('starts closed', () => {
    const { client } = stubClient();
    const { result } = renderHook(() => useStepUp(), {
      wrapper: wrapperFor(client),
    });

    expect(result.current).toMatchObject({
      open: false,
      maxAge: null,
      pending: false,
      error: null,
    });
  });

  it('opens with the challenge max_age and parks the caller', async () => {
    const { client } = stubClient();
    const { result } = renderHook(() => useStepUp(), {
      wrapper: wrapperFor(client),
    });
    const write = gatedWrite('deleted', 300);
    let settled = false;

    act(() => {
      void result.current
        .withStepUp(write)('ws_1')
        .finally(() => {
          settled = true;
        })
        .catch(() => undefined);
    });

    await waitFor(() => {
      expect(result.current.open).toBe(true);
    });
    expect(result.current.maxAge).toBe(300);
    expect(settled).toBe(false);
  });

  it('replays the original call once on success and resolves the caller', async () => {
    const { client, stepUp } = stubClient();
    const { result } = renderHook(() => useStepUp(), {
      wrapper: wrapperFor(client),
    });
    const write = gatedWrite('deleted', 300);
    let call!: Promise<string>;

    act(() => {
      call = result.current.withStepUp(write)('ws_1');
    });
    await waitFor(() => {
      expect(result.current.open).toBe(true);
    });

    let ok = false;
    await act(async () => {
      ok = await result.current.submit({ password: 'hunter2' });
    });

    expect(ok).toBe(true);
    await expect(call).resolves.toBe('deleted');
    expect(stepUp).toHaveBeenCalledWith({ password: 'hunter2' });
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith('ws_1');
    expect(result.current).toMatchObject({
      open: false,
      maxAge: null,
      pending: false,
      error: null,
    });
  });

  it('rejects the caller with the replay failure, without reopening on a second challenge', async () => {
    const { client } = stubClient();
    const { result } = renderHook(() => useStepUp(), {
      wrapper: wrapperFor(client),
    });
    const write = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(challenge(60));
    let call!: Promise<string>;

    act(() => {
      call = result.current.withStepUp(write)();
      call.catch(() => undefined);
    });
    await waitFor(() => {
      expect(result.current.open).toBe(true);
    });
    await act(async () => {
      await result.current.submit({ code: '123456' });
    });

    await expect(call).rejects.toBeInstanceOf(StepUpRequiredError);
    expect(write).toHaveBeenCalledTimes(2);
    expect(result.current.open).toBe(false);
  });

  it('keeps the prompt open with the refusal on a wrong password', async () => {
    const refusal = {
      ok: false,
      reason: 'invalid-password',
      code: 'INVALID_CREDENTIALS',
      message: 'Incorrect password.',
    };
    const { client } = stubClient(refusal);
    const { result } = renderHook(() => useStepUp(), {
      wrapper: wrapperFor(client),
    });
    const write = gatedWrite('deleted');

    act(() => {
      result.current
        .withStepUp(write)('ws_1')
        .catch(() => undefined);
    });
    await waitFor(() => {
      expect(result.current.open).toBe(true);
    });
    let ok = true;
    await act(async () => {
      ok = await result.current.submit({ password: 'nope' });
    });

    expect(ok).toBe(false);
    expect(result.current.open).toBe(true);
    expect(result.current.error).toEqual(refusal);
    expect(result.current.pending).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('surfaces a thrown step-up as an error and keeps the prompt open', async () => {
    const { client, stepUp } = stubClient();
    stepUp.mockRejectedValueOnce(new Error('Network down.'));
    const { result } = renderHook(() => useStepUp(), {
      wrapper: wrapperFor(client),
    });

    act(() => {
      result.current
        .withStepUp(gatedWrite('x'))('ws_1')
        .catch(() => undefined);
    });
    await waitFor(() => {
      expect(result.current.open).toBe(true);
    });
    await act(async () => {
      await result.current.submit({ password: 'pw' });
    });

    expect(result.current.open).toBe(true);
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('Network down.');
  });

  it('routes a passkey submit to stepUpWithPasskey', async () => {
    const { client, stepUp, stepUpWithPasskey } = stubClient();
    const { result } = renderHook(() => useStepUp(), {
      wrapper: wrapperFor(client),
    });
    let call!: Promise<string>;

    act(() => {
      call = result.current.withStepUp(gatedWrite('done'))('ws_1');
    });
    await waitFor(() => {
      expect(result.current.open).toBe(true);
    });
    await act(async () => {
      await result.current.submit({ passkey: true });
    });

    await expect(call).resolves.toBe('done');
    expect(stepUpWithPasskey).toHaveBeenCalledWith({});
    expect(stepUp).not.toHaveBeenCalled();
  });

  it('rejects the caller with StepUpCancelledError on cancel', async () => {
    const { client, stepUp } = stubClient();
    const { result } = renderHook(() => useStepUp(), {
      wrapper: wrapperFor(client),
    });
    const first = challenge(300);
    const write = vi.fn<() => Promise<string>>().mockRejectedValueOnce(first);
    let call!: Promise<string>;

    act(() => {
      call = result.current.withStepUp(write)();
      call.catch(() => undefined);
    });
    await waitFor(() => {
      expect(result.current.open).toBe(true);
    });
    act(() => {
      result.current.cancel();
    });

    const reason: unknown = await call.catch((thrown: unknown) => thrown);
    expect(reason).toBeInstanceOf(StepUpCancelledError);
    expect((reason as StepUpCancelledError).cause).toBe(first);
    expect(result.current.open).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(stepUp).not.toHaveBeenCalled();
  });

  it('rejects waiting callers on unmount', async () => {
    const { client } = stubClient();
    const { result, unmount } = renderHook(() => useStepUp(), {
      wrapper: wrapperFor(client),
    });
    let call!: Promise<string>;

    act(() => {
      call = result.current.withStepUp(gatedWrite('x'))('ws_1');
      call.catch(() => undefined);
    });
    await waitFor(() => {
      expect(result.current.open).toBe(true);
    });
    unmount();

    await expect(call).rejects.toBeInstanceOf(StepUpCancelledError);
  });

  it('narrows maxAge to the strictest waiting challenge and replays every waiter', async () => {
    const { client, stepUp } = stubClient();
    const { result } = renderHook(() => useStepUp(), {
      wrapper: wrapperFor(client),
    });
    const a = gatedWrite('a', 600);
    const b = gatedWrite('b', 120);
    let callA!: Promise<string>;
    let callB!: Promise<string>;

    act(() => {
      callA = result.current.withStepUp(a)('1');
      callB = result.current.withStepUp(b)('2');
    });
    await waitFor(() => {
      expect(result.current.maxAge).toBe(120);
    });
    await act(async () => {
      await result.current.submit({ password: 'pw' });
    });

    await expect(Promise.all([callA, callB])).resolves.toEqual(['a', 'b']);
    expect(stepUp).toHaveBeenCalledTimes(1);
  });

  it('passes other failures straight through without opening', async () => {
    const { client } = stubClient();
    const { result } = renderHook(() => useStepUp(), {
      wrapper: wrapperFor(client),
    });
    const denied = new ApiError({
      status: 403,
      statusText: 'Forbidden',
      url: 'https://api.example.test/x',
      method: 'POST',
      body: null,
    });

    await expect(
      result.current.withStepUp(() => Promise.reject(denied))()
    ).rejects.toBe(denied);
    expect(result.current.open).toBe(false);
  });

  it('resolves false from submit when nothing is waiting', async () => {
    const { client, stepUp } = stubClient();
    const { result } = renderHook(() => useStepUp(), {
      wrapper: wrapperFor(client),
    });

    await expect(result.current.submit({ password: 'pw' })).resolves.toBe(
      false
    );
    expect(stepUp).not.toHaveBeenCalled();
  });

  it('composes with useMutationWithRefetch, staying isMutating while the prompt is open', async () => {
    const { client } = stubClient();
    const write = gatedWrite('deleted', 300);
    const { result } = renderHook(
      () => {
        const stepUp = useStepUp();
        const mutation = useMutationWithRefetch(
          stepUp.withStepUp(write),
          'workspaces'
        );
        return { stepUp, mutation };
      },
      { wrapper: wrapperFor(client) }
    );
    let call!: Promise<string>;

    act(() => {
      call = result.current.mutation.mutate('ws_1');
    });
    await waitFor(() => {
      expect(result.current.stepUp.open).toBe(true);
    });
    expect(result.current.mutation.isMutating).toBe(true);

    await act(async () => {
      await result.current.stepUp.submit({ password: 'pw' });
    });

    await expect(call).resolves.toBe('deleted');
    await waitFor(() => {
      expect(result.current.mutation.isMutating).toBe(false);
    });
    expect(result.current.mutation.error).toBeNull();
  });

  it('leaves a cancelled mutation clearable with reset', async () => {
    const { client } = stubClient();
    const write = gatedWrite('deleted');
    const { result } = renderHook(
      () => {
        const stepUp = useStepUp();
        const mutation = useMutationWithRefetch(
          stepUp.withStepUp(write),
          'workspaces'
        );
        return { stepUp, mutation };
      },
      { wrapper: wrapperFor(client) }
    );

    act(() => {
      result.current.mutation.mutate('ws_1').catch(() => undefined);
    });
    await waitFor(() => {
      expect(result.current.stepUp.open).toBe(true);
    });
    act(() => {
      result.current.stepUp.cancel();
    });
    await waitFor(() => {
      expect(result.current.mutation.error).toBeInstanceOf(
        StepUpCancelledError
      );
    });
    act(() => {
      result.current.mutation.reset();
    });

    expect(result.current.mutation.error).toBeNull();
    expect(result.current.mutation.isMutating).toBe(false);
  });
});
