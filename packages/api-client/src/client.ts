import { ApiError, ApiNetworkError, ApiTimeoutError } from './errors.js';
import { joinUrl, serializeQuery, type QueryParams } from './query.js';

/** Header the API returns carrying the per request uuid7 correlation id. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** HTTP methods that are safe to retry, per RFC 9110 idempotency. */
const IDEMPOTENT_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Statuses worth a second attempt. 5xx and 429, never a 4xx the caller owns. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * The part of an auth client this package needs, and no more.
 *
 * `@webbpulse/auth` implements it. Declaring the contract here rather than
 * importing the class keeps the dependency one way: auth depends on api-client,
 * never the reverse, so a consumer wanting only the transport pulls in nothing
 * of the session machinery.
 *
 * `getAccessToken` is synchronous for the same reason `getAuthToken` is: it is
 * read on every request and an await there would put a microtask on the hot
 * path. `refresh` is the async one, and it is only reached on a 401.
 */
export interface AuthTokenProvider {
  /** The access token held in memory, or null when there is no session. */
  getAccessToken(): string | null;
  /**
   * Refreshes the access token, resolving to the new one or to null when the
   * session is gone.
   *
   * Implementations must share one in-flight request between concurrent
   * callers. Ten parallel 401s refreshing ten times would look like refresh
   * token reuse to the server, which revokes the whole family.
   */
  refresh(): Promise<string | null>;
}

/** Per request options. */
export interface RequestOptions {
  /** Query parameters. Arrays repeat the key. */
  query?: QueryParams;
  /** Extra headers, merged over the client defaults. */
  headers?: Record<string, string>;
  /**
   * Request body. A plain object is JSON encoded; `URLSearchParams`, `FormData`
   * and `Blob` are passed through untouched so the browser sets its own
   * content type. The form encoded path matters: CarModPicker's login posts
   * `application/x-www-form-urlencoded` to `/auth/token`.
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
   * Turns off the refresh-and-replay on 401 for this call.
   *
   * The identity routes set it: `/api/auth/refresh` cannot refresh itself, and
   * `/api/auth/login` answering 401 means the password was wrong, not that a
   * token expired. Retrying either would be at best pointless and at worst a
   * second rotation that the server reads as reuse.
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
   * Base URL every path is resolved against. One origin for the whole API:
   * the backend splits into per domain Lambdas behind a single HTTP API that
   * routes by path prefix, so the browser still sees exactly one host.
   */
  baseUrl: string;
  /** Default headers merged into every request. */
  headers?: Record<string, string>;
  /**
   * Sends cookies on cross origin requests. Defaults to `'include'`, which the
   * staging access gate requires: its CloudFront signed cookies are set on the
   * staging apex, so a call from the www host to the API host only carries
   * them when credentials are included.
   */
  credentials?: RequestCredentials;
  /** Request timeout in milliseconds. Defaults to 30000. 0 disables it. */
  timeoutMs?: number;
  /** Retry attempts after the first, for idempotent methods. Defaults to 2. */
  retries?: number;
  /** Base backoff delay in milliseconds. Defaults to 250. */
  retryBaseDelayMs?: number;
  /**
   * Returns an auth token to send as a bearer header.
   *
   * Synchronous by design. Both applications read the token straight out of
   * `localStorage`, which needs no await, and an async source would have to be
   * awaited on every request on the hot path. Returning a promise here would
   * stringify into a `Bearer [object Promise]` header, so the type forbids it:
   * resolve the token before constructing the client, or keep the store warm
   * and read it synchronously.
   */
  getAuthToken?: () => string | null | undefined;
  /**
   * The auth client this client asks for a token, and for a refresh on a 401.
   *
   * Supplying it turns on the retry-once behaviour of section 7.2 of the
   * identity standard: a 401 triggers a single refresh, shared with every other
   * concurrent 401 through the auth client's own in-flight promise, and a
   * single replay of the original request. A second 401 is thrown. The retry
   * never recurses, which is the classic interceptor bug that turns one expired
   * token into an infinite loop.
   *
   * The type is the narrow {@link AuthTokenProvider} rather than the concrete
   * class, so this package keeps no dependency on `@webbpulse/auth` and the
   * dependency edge stays one way.
   *
   * Takes precedence over `getAuthToken` when both are set, which is not a
   * configuration worth writing on purpose: the auth client is the one holding
   * the token that the refresh replaces.
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
 * example after a username change. CarModPicker's response interceptor stores
 * it; that behaviour moves here so it is not re-invented per application.
 */
const NEW_TOKEN_HEADER = 'x-new-access-token';

function defaultRequestId(): string {
  if (
    typeof globalThis.crypto !== 'undefined' &&
    typeof globalThis.crypto.randomUUID === 'function'
  ) {
    return globalThis.crypto.randomUUID();
  }
  // Fallback for a runtime without WebCrypto. Correlation only, never a secret.
  return `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
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
 * Encodes the body and returns the content type it implies.
 *
 * Returning `undefined` for the content type means "let the runtime decide",
 * which is required for `FormData`, where the browser has to append the
 * multipart boundary itself.
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
      // A malformed body from a server claiming JSON is still worth surfacing
      // verbatim rather than throwing a parse error that hides the payload.
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
    // Bound so a destructured or injected fetch keeps its receiver. An unbound
    // `globalThis.fetch` throws "Illegal invocation" in a browser.
    const impl = options.fetch ?? globalThis.fetch;
    this.fetchImpl = impl.bind(globalThis);
  }

  /**
   * Returns a client bound to a path prefix on the same base URL.
   *
   * The backend splits into one Lambda per domain behind a single HTTP API
   * that routes by path prefix, so the origin is shared and only the prefix
   * differs. `createDomainClient('/build-lists')` gives that domain its own
   * client without a second connection pool, a second token source or a second
   * copy of the retry policy.
   */
  createDomainClient(prefix: string): ApiClient {
    const normalisedPrefix = prefix === '' ? '' : joinUrl('', prefix);
    return new ApiClient({
      ...this.options,
      baseUrl: `${this.baseUrl}${normalisedPrefix}`,
    });
  }

  /**
   * Sends a request, refreshing and replaying once on a 401.
   *
   * The 401 handling is section 7.2 of the identity standard, and the shape is
   * chosen so it cannot recurse. `requestOnce` holds the whole transport retry
   * loop and knows nothing about auth; this wrapper calls it at most twice and
   * has no loop of its own, so "exactly once" is a property of the control flow
   * rather than a counter someone has to keep correct. A second 401 falls
   * straight through to the caller.
   *
   * The refresh itself is the auth client's, which shares one in-flight promise
   * between every concurrent caller. Ten requests meeting an expired token
   * together make one rotation, not ten.
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
      // The caller aborted while the request was in flight. Refreshing for a
      // request nobody is waiting on rotates a token for nothing.
      if (options.signal?.aborted === true) {
        throw error;
      }
      const token = await auth.refresh();
      if (token === null) {
        // The session is gone. The auth client has already cleared its state
        // and notified its session-ended hook, so the original 401 is the most
        // useful thing to hand back: it names the route that discovered it.
        throw error;
      }
      // Exactly one replay, and `skipAuthRetry` on it so a 401 from the replay
      // cannot start a second refresh. That guard is redundant given this
      // method has no loop, and it is here anyway because the invariant is
      // worth stating in the code rather than only in this comment.
      return this.requestOnce<T>(method, path, {
        ...options,
        skipAuthRetry: true,
      });
    }
  }

  /**
   * One logical request, including the transport level retries.
   *
   * Retries here are for transient transport failures: a network error, a
   * timeout, a 429 or a 5xx, and only on idempotent methods. A 401 is never
   * retried at this level, because a second identical request with the same
   * expired token gets the same answer.
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
        // Exponential backoff with full jitter, so a burst of clients failing
        // together does not retry in lockstep and re-create the spike.
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
    // The correlation id goes out on every request, and stays constant across
    // retries so all attempts for one logical call join up in the trace.
    headers.set(REQUEST_ID_HEADER, requestId);
    if (attempt > 0) {
      headers.set('x-retry-attempt', String(attempt));
    }
    // The auth client first when one is configured. It is the holder of the
    // in-memory token that a refresh replaces, so reading `getAuthToken`
    // instead would attach whatever the older source still had.
    const token =
      this.options.auth === undefined
        ? this.options.getAuthToken?.()
        : this.options.auth.getAccessToken();
    if (typeof token === 'string' && token !== '') {
      headers.set('authorization', `Bearer ${token}`);
    } else if (token !== null && token !== undefined) {
      // A non-string here is almost always an async getAuthToken slipping past
      // a consumer's types. Interpolating it would send the literal header
      // "Bearer [object Promise]", which reads as an auth failure at the API
      // and is very hard to trace back from there.
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
