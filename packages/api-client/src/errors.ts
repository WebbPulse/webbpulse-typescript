/**
 * Error types raised by the client.
 *
 * The two applications disagree today about what a failed request means.
 * CarModPicker's axios instance rejects the promise; Portfolio's `request<T>`
 * swallows everything and returns `{ data: null, error }`, which is why every
 * Portfolio call site has to remember to check `.error` and none of them are
 * type forced to. Both inventories recommend converging on the rejecting
 * contract, so this client throws and the migration moves Portfolio onto it
 * deliberately rather than meeting in the middle.
 */

/** Shape FastAPI uses for a single request validation failure. */
export interface ValidationErrorItem {
  loc: (string | number)[];
  msg: string;
  type: string;
}

/** The body FastAPI returns for a 4xx or 5xx, as far as it is predictable. */
export interface ApiErrorBody {
  detail?: string | ValidationErrorItem[];
  message?: string;
  [key: string]: unknown;
}

function isValidationErrorItems(value: unknown): value is ValidationErrorItem[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        'msg' in item &&
        typeof (item as { msg: unknown }).msg === 'string'
    )
  );
}

/**
 * Turns a parsed error body into one human readable line.
 *
 * This is `parseApiError` from CarModPicker's `hooks/UseApiRequest.tsx`, which
 * is the de facto error handling layer in that application. It is exported so
 * a caller can render a message without reimplementing the FastAPI detail
 * unpacking a fourth time.
 */
export function formatApiErrorMessage(
  body: unknown,
  fallback = 'An unexpected error occurred.'
): string {
  if (typeof body === 'string' && body.trim()) {
    return body;
  }
  if (typeof body !== 'object' || body === null) {
    return fallback;
  }
  const candidate = body as ApiErrorBody;
  const detail = candidate.detail;
  if (typeof detail === 'string' && detail.trim()) {
    return detail;
  }
  if (isValidationErrorItems(detail) && detail.length > 0) {
    return detail.map((item) => item.msg).join('. ');
  }
  if (typeof candidate.message === 'string' && candidate.message.trim()) {
    return candidate.message;
  }
  return fallback;
}

/** Thrown for any non 2xx response. Carries the status and the parsed body. */
export class ApiError extends Error {
  /** HTTP status code. */
  readonly status: number;
  /** HTTP status text, when the runtime supplies one. */
  readonly statusText: string;
  /** Parsed response body: JSON when parseable, the raw text otherwise. */
  readonly body: unknown;
  /** Absolute URL that produced the failure. */
  readonly url: string;
  /** HTTP method used, upper cased. */
  readonly method: string;
  /**
   * Value of the request id response header, when the API returned one.
   *
   * The backend assigns a uuid7 request id per request. Surfacing it here is
   * what makes a browser side error report joinable to the CloudWatch logs and
   * the OpenTelemetry trace for the same request.
   */
  readonly requestId: string | undefined;

  constructor(init: {
    status: number;
    statusText: string;
    body: unknown;
    url: string;
    method: string;
    requestId?: string | undefined;
  }) {
    super(
      formatApiErrorMessage(
        init.body,
        `Request failed with status ${String(init.status)}.`
      )
    );
    this.name = 'ApiError';
    this.status = init.status;
    this.statusText = init.statusText;
    this.body = init.body;
    this.url = init.url;
    this.method = init.method;
    this.requestId = init.requestId;
    // Restores the prototype chain so `instanceof ApiError` holds even when a
    // consumer compiles this package down to ES5 through its own bundler.
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  /** True for 401, the status the auth layer treats as "session is gone". */
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  /** True for 4xx. */
  get isClientError(): boolean {
    return this.status >= 400 && this.status < 500;
  }

  /** True for 5xx. */
  get isServerError(): boolean {
    return this.status >= 500;
  }
}

/** Thrown when the request aborts, whether by timeout or by caller signal. */
export class ApiTimeoutError extends Error {
  readonly url: string;
  readonly method: string;
  readonly timeoutMs: number | undefined;

  constructor(init: {
    url: string;
    method: string;
    timeoutMs?: number | undefined;
  }) {
    super(
      init.timeoutMs === undefined
        ? `Request to ${init.url} was aborted.`
        : `Request to ${init.url} timed out after ${String(init.timeoutMs)}ms.`
    );
    this.name = 'ApiTimeoutError';
    this.url = init.url;
    this.method = init.method;
    this.timeoutMs = init.timeoutMs;
    Object.setPrototypeOf(this, ApiTimeoutError.prototype);
  }
}

/** Thrown when fetch itself fails, which in a browser means the network. */
export class ApiNetworkError extends Error {
  readonly url: string;
  readonly method: string;

  constructor(init: { url: string; method: string; cause?: unknown }) {
    super(`Network request to ${init.url} failed.`, { cause: init.cause });
    this.name = 'ApiNetworkError';
    this.url = init.url;
    this.method = init.method;
    Object.setPrototypeOf(this, ApiNetworkError.prototype);
  }
}
