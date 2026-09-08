/**
 * Opt in `{ data, error }` envelope over the throwing client.
 *
 * The client rejects on a non 2xx, and that stays the default: a rejection is
 * the contract both application inventories recommended, because an envelope
 * nobody is type forced to check is an envelope call sites forget to check.
 *
 * What the envelope is good for is the migration. Portfolio's `services/api.ts`
 * has roughly sixty call sites reading `response.error`, and converting the
 * transport and every one of those call sites in a single change is a large
 * diff with no safe intermediate state. So Portfolio wrote a twelve line
 * adapter around `ApiError` and `formatApiErrorMessage` to hold the envelope in
 * place while the transport moved underneath it. That adapter is here now,
 * typed and tested once, rather than copied into the next application that
 * needs the same staging step.
 *
 * Nothing here changes the client. `toEnvelope` wraps one call and
 * `createEnvelopeClient` wraps a whole client; both sit on top of the throwing
 * methods and neither is reachable unless a consumer imports it.
 */

import type { ApiClient, ApiResponse, RequestOptions } from './client.js';
import { ApiError, formatApiErrorMessage } from './errors.js';

/**
 * Result of an enveloped call. Exactly one of `data` and `error` is meaningful:
 * `error` is `undefined` on success and `data` is `null` on failure.
 *
 * `data` is `T | null` rather than `T`, which is the one place this departs
 * from Portfolio's hand rolled version. That one declared `data: T` and wrote
 * `null as T` into it on the error path, so every call site read a value the
 * type said could not be null. Widening it here is what makes the check the
 * compiler's job rather than the reader's.
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
   * Called with every failure before it is converted.
   *
   * Portfolio's adapter had a bare `console.error` here. Reporting is a
   * consumer decision, so this package logs nothing and offers the hook: pass
   * `console.error` to keep that behaviour, or route it to a real reporter.
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
      // The parsed body first, so FastAPI's `detail` reaches the UI rather
      // than the generic "Request failed with status 401." line. `error.message`
      // is already that formatted string, which makes it the right fallback.
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
 * Runs one call and returns `{ data, error }` instead of rejecting.
 *
 * ```ts
 * const { data, error } = await toEnvelope(() => client.get<Project[]>('/projects/'));
 * ```
 *
 * The argument is a thunk rather than a promise so the call is made inside the
 * `try`. Passing `toEnvelope(client.get('/x'))` would start the request first
 * and, on a synchronous throw from the client, reject before this function ever
 * saw it.
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
 * An `ApiClient` shaped surface whose methods resolve to an envelope.
 *
 * The method signatures mirror `ApiClient` exactly, so a call site moves
 * between the two by changing which object it holds and how it reads the
 * result, not by rewriting its arguments.
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
 * Wraps a client so every method resolves to `{ data, error }`.
 *
 * ```ts
 * const api = createEnvelopeClient(createApiClient({ baseUrl }));
 * const { data, error } = await api.get<Project[]>('/projects/');
 * ```
 *
 * The underlying client is unchanged and reachable as `.client`, so a module
 * can hold both and move call sites over one at a time.
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
    // The prefix binding happens on the underlying client, so the domain
    // client keeps the token source and retry policy and the envelope options
    // carry across unchanged.
    createDomainClient: (prefix) =>
      createEnvelopeClient(client.createDomainClient(prefix), options),
  };
}
