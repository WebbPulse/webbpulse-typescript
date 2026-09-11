/**
 * Error types raised by the client, which rejects on a non 2xx rather than
 * returning a result an unforced call site can forget to check.
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

/**
 * The error envelope every WebbPulse backend renders on a non 2xx. `success`,
 * `status`, `message` and `request_id` are always present; the other two are
 * absent unless the service opted into them, never explicitly null.
 */
export interface WebbPulseErrorBody {
  /** Always `false`. It is what distinguishes the envelope from a success body. */
  success: false;
  /** HTTP status, duplicated from the status line. */
  status: number;
  /** Human readable message. Safe to render: the backend writes it for a caller. */
  message: string;
  /** Request id, the same value echoed in the `X-Request-ID` response header. */
  request_id: string;
  /**
   * Stable machine readable code, when the service enabled `error_codes`.
   * Branch on this rather than on the message text.
   */
  error_code?: string;
  /**
   * Structured detail, when the service enabled `validation_details`: a list
   * with one entry per offending field, or a mapping for anything else.
   */
  details?: unknown[] | Record<string, unknown>;
}

/**
 * Narrows an unknown value to the WebbPulse error envelope. The check is
 * `success === false` plus a string `message`: deliberately permissive, so a
 * proxy that dropped a key does not cost the caller the message.
 */
export function isWebbPulseErrorBody(
  value: unknown
): value is WebbPulseErrorBody {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate['success'] === false && typeof candidate['message'] === 'string'
  );
}

/**
 * The fields an application reads off a failed request, in one flat object.
 * `message` is always usable; the rest are `undefined` when unsent.
 */
export interface WebbPulseErrorInfo {
  /** The envelope's message, or the best line the other shapes yield. */
  message: string;
  /** `error_code` when the service enabled it. */
  errorCode: string | undefined;
  /** `details` when the service enabled it. */
  details: unknown[] | Record<string, unknown> | undefined;
  /**
   * The request id, read from the envelope's `request_id` first and the
   * response header second, so a forwarded body still carries it.
   */
  requestId: string | undefined;
  /** HTTP status, from the response rather than the body. */
  status: number;
}

function isValidationErrorItems(
  value: unknown
): value is ValidationErrorItem[] {
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
 * Turns a parsed error body into one human readable line, unpacking the
 * WebbPulse envelope and the FastAPI `detail` shapes.
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
  if (isWebbPulseErrorBody(body) && body.message.trim()) {
    return body.message;
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

/**
 * Statuses on which a `Retry-After` header is read: the same set `client.ts`
 * retries on, since the hint is only useful where a caller might try again.
 */
const RETRY_AFTER_STATUSES: ReadonlySet<number> = new Set([
  408, 425, 429, 500, 502, 503, 504,
]);

/**
 * Parses a `Retry-After` header into whole seconds, accepting both RFC 9110
 * forms: a bare non-negative integer, or an HTTP-date measured against `now`,
 * rounded up and floored at zero. Unparseable values return `undefined`.
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: number = Date.now()
): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isFinite(seconds) ? seconds : undefined;
  }
  if (!/[a-zA-Z]/.test(trimmed)) {
    return undefined;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) {
    return undefined;
  }
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * Reads the retry hint off a response, on the statuses where one is meaningful.
 */
export function retryAfterFromHeaders(
  status: number,
  headers: { get(name: string): string | null }
): number | undefined {
  if (!RETRY_AFTER_STATUSES.has(status)) {
    return undefined;
  }
  return parseRetryAfter(headers.get('retry-after'));
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
   * Value of the request id response header, which joins a browser side error
   * report up to the logs and the trace for the same request.
   */
  readonly requestId: string | undefined;
  /**
   * Seconds to wait before retrying, read off `Retry-After` on the retryable
   * statuses and `undefined` everywhere else. A hint and not a promise: treat
   * it as a floor and keep whatever backoff the call site already has.
   */
  readonly retryAfterSeconds: number | undefined;

  constructor(init: {
    status: number;
    statusText: string;
    body: unknown;
    url: string;
    method: string;
    requestId?: string | undefined;
    retryAfterSeconds?: number | undefined;
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
    this.retryAfterSeconds = init.retryAfterSeconds;
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

/**
 * Reads the WebbPulse error envelope off an `ApiError` as one flat camel case
 * object. Always returns a value: `message` is never empty and `errorCode` is
 * `undefined` rather than absent, so a `switch` on it can be exhaustive.
 */
export function getWebbPulseError(error: ApiError): WebbPulseErrorInfo {
  const body = error.body;
  if (isWebbPulseErrorBody(body)) {
    return {
      message: body.message.trim()
        ? body.message
        : formatApiErrorMessage(
            body,
            `Request failed with status ${String(error.status)}.`
          ),
      errorCode: body.error_code,
      details: body.details,
      requestId: body.request_id || error.requestId,
      status: error.status,
    };
  }
  return {
    message: error.message,
    errorCode: undefined,
    details: undefined,
    requestId: error.requestId,
    status: error.status,
  };
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
