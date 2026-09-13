import {
  ApiError,
  ApiNetworkError,
  ApiTimeoutError,
  retryAfterFromHeaders,
} from './errors.js';
import { joinUrl, serializeQuery, type QueryParams } from './query.js';

/** Header the API returns carrying the per request uuid7 correlation id. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** HTTP methods that are safe to retry, per RFC 9110 idempotency. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Statuses worth a second attempt. 5xx and 429, never a 4xx the caller owns. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * The part of an auth client this package needs, declared here rather than
 * imported so the dependency edge stays one way. `getAccessToken` is
 * synchronous because it is read on every request; `refresh` is not.
 */
export interface AuthTokenProvider {
  /** The access token held in memory, or null when there is no session. */
  getAccessToken(): string | null;
  /**
   * Refreshes the access token, resolving to the new one or to null when the
   * session is gone. Implementations must share one in-flight request between
   * concurrent callers, or the server reads the burst as token reuse.
   */
  refresh(): Promise<string | null>;
  /**
   * Resolves the token to send once the first refresh of the page load has
   * settled, so a request made during boot carries the restored session instead
   * of going out anonymous. Resolves to null as soon as that refresh finds no
   * session, and never starts one of its own. Optional: a provider without it
   * falls back to the synchronous read.
   */
  waitForToken?(): Promise<string | null>;
}

/** Per request options. */
export interface RequestOptions {
  /** Query parameters. Arrays repeat the key. */
  query?: QueryParams;
  /** Extra headers, merged over the client defaults. */
  headers?: Record<string, string>;
  /**
   * Request body. A plain object is JSON encoded; `URLSearchParams`, `FormData`
   * and `Blob` pass through so the browser sets its own content type.
   */
  body?: unknown;
  /** Abort signal from the caller. Composed with the timeout signal. */
  signal?: AbortSignal;
  /** Overrides the client timeout for this call. 0 disables it. */
  timeoutMs?: number;
  /** Overrides the retry count for this call. Ignored for unsafe methods. */
  retries?: number;
  /** Correlation id sent on the request. Generated when omitted. */
  requestId?: string;
  /** Skips JSON parsing and resolves the raw Response. */
  raw?: boolean;
  /**
   * Turns off the refresh-and-replay on 401 for this call. The identity routes
   * set it: neither refresh nor login can be repaired by a refresh.
   */
  skipAuthRetry?: boolean;
}

/** A response, plus the metadata a caller needs for logging and auth. */
export interface ApiResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  /** The request id the API echoed back, when it sent one. */
  requestId: string | undefined;
}

/** Client construction options. */
export interface ApiClientOptions {
  /**
   * Base URL every path is resolved against. One origin for the whole API: the
   * backend routes by path prefix, so the browser sees exactly one host.
   */
  baseUrl: string;
  /** Default headers merged into every request. */
  headers?: Record<string, string>;
  /**
   * Sends cookies on cross origin requests. Defaults to `'include'`, which the
   * staging access gate's signed cookies require.
   */
  credentials?: RequestCredentials;
  /** Request timeout in milliseconds. Defaults to 30000. 0 disables it. */
  timeoutMs?: number;
  /** Retry attempts after the first, for idempotent methods. Defaults to 2. */
  retries?: number;
  /** Base backoff delay in milliseconds. Defaults to 250. */
  retryBaseDelayMs?: number;
  /**
   * Ceiling in milliseconds on a wait taken from a `Retry-After` header.
   * Defaults to 5000. A longer `Retry-After` is not waited out at all: the
   * `ApiError` is thrown so the caller can surface it instead of stalling.
   */
  retryAfterMaxMs?: number;
  /**
   * Returns an auth token to send as a bearer header. Synchronous by design:
   * a promise here would stringify into a `Bearer [object Promise]` header,
   * so resolve the token before constructing the client.
   */
  getAuthToken?: () => string | null | undefined;
  /**
   * The auth client this client asks for a token, and for a refresh on a 401.
   * Supplying it turns on one refresh and one replay, never recursing. Takes
   * precedence over `getAuthToken`, which holds the older token source.
   */
  auth?: AuthTokenProvider;
  /** Called with a token the API rotated in via a response header. */
  onTokenRefresh?: (token: string) => void;
  /** Called for every 401, so the auth layer can clear its session. */
  onUnauthorized?: (error: ApiError) => void;
  /** Generates a request id. Defaults to `crypto.randomUUID`. */
  generateRequestId?: () => string;
  /** Injected for tests. Defaults to `globalThis.fetch`. */
  fetch?: typeof globalThis.fetch;
}

/**
 * Header the API sets when it issues a replacement token mid session, for
 * example after a username change.
 */
const NEW_TOKEN_HEADER = 'x-new-access-token';

function defaultRequestId(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The wait a failure's `Retry-After` asks for in milliseconds, or undefined
 * when the server sent no usable header.
 */
function retryAfterDelayMs(error: unknown): number | undefined {
  if (!(error instanceof ApiError)) {
    return undefined;
  }
  const seconds = error.retryAfterSeconds;
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return undefined;
  }
  return seconds * 1000;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort(): void {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Encodes the body and returns the content type it implies. `undefined` means
 * let the runtime decide, which `FormData` needs for its boundary.
 */
function encodeBody(body: unknown): {
  body: BodyInit | undefined;
  contentType: string | undefined;
} {
  if (body === undefined || body === null) {
    return { body: undefined, contentType: undefined };
  }
  if (typeof body === 'string') {
    return { body, contentType: 'application/json' };
  }
  if (
    body instanceof URLSearchParams ||
    body instanceof FormData ||
    body instanceof Blob ||
    body instanceof ArrayBuffer
  ) {
    return { body: body as BodyInit, contentType: undefined };
  }
  return { body: JSON.stringify(body), contentType: 'application/json' };
}

/** Parses a response body as JSON when it looks like JSON, text otherwise. */
async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) {
    return undefined;
  }
  const contentType = response.headers.get('content-type') ?? '';
  const text = await response.text();
  if (text === '') {
    return undefined;
  }
  if (contentType.includes('json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

/**
 * Typed fetch client. Framework free: no React, no axios, no DOM beyond
 * `fetch`, `AbortController` and the standard `Headers` type, so it runs
 * unchanged in a browser, in Node 22 and in a test runner.
 */
export class ApiClient {
  readonly baseUrl: string;
  private readonly options: ApiClientOptions;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: ApiClientOptions) {
    this.options = options;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    const impl = options.fetch ?? globalThis.fetch;
    this.fetchImpl = impl.bind(globalThis);
  }

  /**
   * Returns a client bound to a path prefix on the same base URL, so a domain
   * gets its own client without a second token source or retry policy.
   */
  createDomainClient(prefix: string): ApiClient {
    const normalisedPrefix = prefix === '' ? '' : joinUrl('', prefix);
    return new ApiClient({
      ...this.options,
      baseUrl: `${this.baseUrl}${normalisedPrefix}`,
    });
  }

  /**
   * Sends a request, refreshing and replaying once on a 401. This wrapper has
   * no loop of its own and calls `requestOnce` at most twice, so exactly once
   * is a property of the control flow rather than a counter.
   */
  async request<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {}
  ): Promise<ApiResponse<T>> {
    const auth = this.options.auth;
    if (auth === undefined || options.skipAuthRetry === true) {
      return this.requestOnce<T>(method, path, options);
    }

    try {
      return await this.requestOnce<T>(method, path, options);
    } catch (error) {
      if (!(error instanceof ApiError) || !error.isUnauthorized) {
        throw error;
      }
      if (options.signal?.aborted === true) {
        throw error;
      }
      const token = await auth.refresh();
      if (token === null) {
        throw error;
      }
      return this.requestOnce<T>(method, path, {
        ...options,
        skipAuthRetry: true,
      });
    }
  }

  /**
   * One logical request, including the transport level retries: network
   * errors, timeouts, 429s and 5xx on idempotent methods only. A 401 is never
   * retried here, since the same expired token gets the same answer.
   */
  private async requestOnce<T = unknown>(
    method: string,
    path: string,
    options: RequestOptions = {}
  ): Promise<ApiResponse<T>> {
    const upperMethod = method.toUpperCase();
    const queryString = serializeQuery(options.query);
    const url = `${joinUrl(this.baseUrl, path)}${queryString === '' ? '' : `?${queryString}`}`;

    const maxRetries = IDEMPOTENT_METHODS.has(upperMethod)
      ? (options.retries ?? this.options.retries ?? 2)
      : 0;
    const baseDelay = this.options.retryBaseDelayMs ?? 250;
    const retryAfterMaxMs = this.options.retryAfterMaxMs ?? 5000;
    const requestId = options.requestId ?? this.requestIdFactory()();

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await this.attempt<T>(
          upperMethod,
          url,
          options,
          requestId,
          attempt
        );
      } catch (error) {
        lastError = error;
        const retriable =
          attempt < maxRetries && this.isRetriable(error, options.signal);
        if (!retriable) {
          throw error;
        }
        const retryAfterMs = retryAfterDelayMs(error);
        if (retryAfterMs !== undefined) {
          if (retryAfterMs > retryAfterMaxMs) {
            throw error;
          }
          await sleep(retryAfterMs, options.signal);
          continue;
        }
        const ceiling = baseDelay * 2 ** attempt;
        await sleep(Math.random() * ceiling, options.signal);
      }
    }
    throw lastError;
  }

  private requestIdFactory(): () => string {
    return this.options.generateRequestId ?? defaultRequestId;
  }

  /** A failure is retriable when it is transient and the caller did not abort. */
  private isRetriable(error: unknown, callerSignal?: AbortSignal): boolean {
    if (callerSignal?.aborted === true) {
      return false;
    }
    if (error instanceof ApiNetworkError) {
      return true;
    }
    if (error instanceof ApiTimeoutError) {
      return true;
    }
    if (error instanceof ApiError) {
      return RETRYABLE_STATUSES.has(error.status);
    }
    return false;
  }

  private async attempt<T>(
    method: string,
    url: string,
    options: RequestOptions,
    requestId: string,
    attempt: number
  ): Promise<ApiResponse<T>> {
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? 30_000;
    const controller = new AbortController();
    const abortHandlers: (() => void)[] = [];

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
    }

    if (options.signal !== undefined) {
      const callerSignal = options.signal;
      if (callerSignal.aborted) {
        controller.abort();
      } else {
        const onAbort = (): void => {
          controller.abort();
        };
        callerSignal.addEventListener('abort', onAbort, { once: true });
        abortHandlers.push(() =>
          callerSignal.removeEventListener('abort', onAbort)
        );
      }
    }

    const headers = new Headers();
    for (const [key, value] of Object.entries(this.options.headers ?? {})) {
      headers.set(key, value);
    }
    const encoded = encodeBody(options.body);
    if (encoded.contentType !== undefined) {
      headers.set('content-type', encoded.contentType);
    }
    headers.set(REQUEST_ID_HEADER, requestId);
    if (attempt > 0) {
      headers.set('x-retry-attempt', String(attempt));
    }
    const auth = this.options.auth;
    const token =
      auth === undefined
        ? this.options.getAuthToken?.()
        : auth.waitForToken === undefined
          ? auth.getAccessToken()
          : await auth.waitForToken();
    if (typeof token === 'string' && token !== '') {
      headers.set('authorization', `Bearer ${token}`);
    } else if (token !== null && token !== undefined) {
      throw new TypeError(
        'getAuthToken must return a string synchronously. It returned ' +
          `${typeof token}, which cannot be sent as a bearer token.`
      );
    }
    for (const [key, value] of Object.entries(options.headers ?? {})) {
      headers.set(key, value);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        credentials: this.options.credentials ?? 'include',
        signal: controller.signal,
        ...(encoded.body === undefined ? {} : { body: encoded.body }),
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ApiTimeoutError({
          url,
          method,
          ...(timedOut ? { timeoutMs } : {}),
        });
      }
      throw new ApiNetworkError({ url, method, cause: error });
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      for (const remove of abortHandlers) {
        remove();
      }
    }

    const responseRequestId =
      response.headers.get(REQUEST_ID_HEADER) ?? undefined;

    const rotatedToken = response.headers.get(NEW_TOKEN_HEADER);
    if (rotatedToken !== null && rotatedToken !== '') {
      this.options.onTokenRefresh?.(rotatedToken);
    }

    if (!response.ok) {
      const body = await parseBody(response);
      const apiError = new ApiError({
        status: response.status,
        statusText: response.statusText,
        body,
        url,
        method,
        requestId: responseRequestId,
        retryAfterSeconds: retryAfterFromHeaders(
          response.status,
          response.headers
        ),
      });
      if (apiError.isUnauthorized) {
        this.options.onUnauthorized?.(apiError);
      }
      throw apiError;
    }

    if (options.raw === true) {
      return {
        data: response as unknown as T,
        status: response.status,
        headers: response.headers,
        requestId: responseRequestId,
      };
    }

    const data = (await parseBody(response)) as T;
    return {
      data,
      status: response.status,
      headers: response.headers,
      requestId: responseRequestId,
    };
  }

  get<T = unknown>(
    path: string,
    options?: Omit<RequestOptions, 'body'>
  ): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path, options);
  }

  post<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, { ...options, body });
  }

  put<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<ApiResponse<T>> {
    return this.request<T>('PUT', path, { ...options, body });
  }

  patch<T = unknown>(
    path: string,
    body?: unknown,
    options?: RequestOptions
  ): Promise<ApiResponse<T>> {
    return this.request<T>('PATCH', path, { ...options, body });
  }

  delete<T = unknown>(
    path: string,
    options?: RequestOptions
  ): Promise<ApiResponse<T>> {
    return this.request<T>('DELETE', path, options);
  }
}

/** Constructs a client. Equivalent to `new ApiClient(options)`. */
export function createApiClient(options: ApiClientOptions): ApiClient {
  return new ApiClient(options);
}
