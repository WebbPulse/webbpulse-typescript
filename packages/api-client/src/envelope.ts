/**
 * Opt in `{ data, error }` envelope over the throwing client, for migrating an
 * application whose call sites read `response.error`. Nothing here changes the
 * client: both wrappers sit on top of the throwing methods.
 */

import type { ApiClient, ApiResponse, RequestOptions } from './client.js';
import { ApiError, formatApiErrorMessage } from './errors.js';

/**
 * Result of an enveloped call. Exactly one of `data` and `error` is meaningful:
 * `error` is `undefined` on success and `data` is `null` on failure, which is
 * typed as `T | null` so the compiler enforces the check.
 */
export interface ApiEnvelope<T> {
  /** Parsed response body on success, `null` on failure. */
  data: T | null;
  /** Human readable message on failure, `undefined` on success. */
  error?: string;
  /** Status code, present whenever a response was received. */
  status?: number;
  /** Request id the API echoed back, for joining up logs and traces. */
  requestId?: string | undefined;
  /** The thrown value, for a caller that needs more than the message. */
  cause?: unknown;
}

/** Options for `toEnvelope` and `createEnvelopeClient`. */
export interface EnvelopeOptions {
  /**
   * Message used when the thrown value carries nothing readable. Defaults to
   * the message on the error itself, and to a generic line for a non `Error`.
   */
  fallbackMessage?: string;
  /**
   * Called with every failure before it is converted. This package logs
   * nothing itself; pass `console.error` or a real reporter.
   */
  onError?: (error: unknown) => void;
}

const DEFAULT_FALLBACK = 'An unexpected error occurred.';

/** Converts a thrown value into the envelope's error fields. */
function toErrorEnvelope<T>(
  error: unknown,
  options: EnvelopeOptions
): ApiEnvelope<T> {
  options.onError?.(error);

  if (error instanceof ApiError) {
    return {
      data: null,
      error: formatApiErrorMessage(error.body, error.message),
      status: error.status,
      requestId: error.requestId,
      cause: error,
    };
  }

  if (error instanceof Error) {
    return {
      data: null,
      error:
        error.message === ''
          ? (options.fallbackMessage ?? DEFAULT_FALLBACK)
          : error.message,
      cause: error,
    };
  }

  return {
    data: null,
    error: options.fallbackMessage ?? DEFAULT_FALLBACK,
    cause: error,
  };
}

/**
 * Runs one call and returns `{ data, error }` instead of rejecting. The
 * argument is a thunk rather than a promise so the call is made inside the
 * `try` and a synchronous throw is caught too.
 */
export async function toEnvelope<T>(
  call: () => Promise<ApiResponse<T>>,
  options: EnvelopeOptions = {}
): Promise<ApiEnvelope<T>> {
  try {
    const response = await call();
    return {
      data: response.data,
      status: response.status,
      requestId: response.requestId,
    };
  } catch (error) {
    return toErrorEnvelope<T>(error, options);
  }
}

/**
 * An `ApiClient` shaped surface whose methods resolve to an envelope. The
 * signatures mirror `ApiClient`, so only the result reading changes.
 */
export interface EnvelopeClient {
  /** The client this wraps, for a call that wants the throwing contract. */
  readonly client: ApiClient;
  request<T = unknown>(
    method: string,
    path: string,
    options?: RequestOptions
  ): Promise<ApiEnvelope<T>>;
  get<T = unknown>(
    path: string,
    options?: Omit<RequestOptions, 'body'>
  ): Promise<ApiEnvelope<T>>;
  post<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<ApiEnvelope<T>>;
  put<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<ApiEnvelope<T>>;
  patch<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<ApiEnvelope<T>>;
  delete<T = unknown>(
    path: string,
    options?: RequestOptions
  ): Promise<ApiEnvelope<T>>;
  /** Envelope client bound to a path prefix, matching `createDomainClient`. */
  createDomainClient(prefix: string): EnvelopeClient;
}

/**
 * Wraps a client so every method resolves to `{ data, error }`. The underlying
 * client is unchanged and reachable as `.client`, so a module can hold both.
 */
export function createEnvelopeClient(
  client: ApiClient,
  options: EnvelopeOptions = {}
): EnvelopeClient {
  return {
    client,
    request: (method, path, requestOptions) =>
      toEnvelope(() => client.request(method, path, requestOptions), options),
    get: (path, requestOptions) =>
      toEnvelope(() => client.get(path, requestOptions), options),
    post: (path, body, requestOptions) =>
      toEnvelope(() => client.post(path, body, requestOptions), options),
    put: (path, body, requestOptions) =>
      toEnvelope(() => client.put(path, body, requestOptions), options),
    patch: (path, body, requestOptions) =>
      toEnvelope(() => client.patch(path, body, requestOptions), options),
    delete: (path, requestOptions) =>
      toEnvelope(() => client.delete(path, requestOptions), options),
    createDomainClient: (prefix) =>
      createEnvelopeClient(client.createDomainClient(prefix), options),
  };
}
