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

/**
 * The error envelope every WebbPulse backend renders on a non 2xx.
 *
 * Built by `error_body` in `webbpulse.http` (the shared Python package) and
 * installed application wide by `register_error_handlers`, so a 404 from a
 * route, a 422 from request validation and a 500 from an unhandled exception
 * all arrive in this one shape rather than three.
 *
 * Four fields are always present and always in this order: `success`, `status`,
 * `message` and `request_id`. `error_code` and `details` are omitted entirely
 * unless the service opted into them (`register_error_handlers(error_codes=True,
 * validation_details=True)`), which is why both are optional here rather than
 * nullable: an absent key and an explicit `null` are different answers and the
 * backend only ever produces the former.
 *
 * `status` is duplicated from the HTTP status line deliberately. A body that
 * has been logged, serialised into an error report or passed through a queue
 * no longer has a response beside it, and the envelope stays self describing.
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
   *
   * Derived from the status for handled statuses (`NOT_FOUND`, `CONFLICT`,
   * `VALIDATION_ERROR`, `INTERNAL_ERROR`), and overridable per route, so an
   * application branches on this rather than on the message text.
   */
  error_code?: string;
  /**
   * Structured detail, when the service enabled `validation_details`.
   *
   * A list for validation failures, one entry per offending field, or a mapping
   * for anything else. The backend echoes it verbatim to the caller, so it
   * never carries a rejected input value or an internal identifier.
   */
  details?: unknown[] | Record<string, unknown>;
}

/**
 * Narrows an unknown value to the WebbPulse error envelope.
 *
 * The check is on `success === false` plus a string `message`, not on the full
 * field set. `status` and `request_id` are always written by `error_body`, but
 * requiring them here would make the guard fail closed against a body that
 * crossed a proxy which dropped a key, and the useful part (the message) would
 * be lost for no gain. `success: false` is the discriminant that a FastAPI
 * `detail` body and a bare `{ message }` both lack, so it alone is enough to
 * tell the envelope apart from the shapes below.
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
 *
 * Returned by {@link getWebbPulseError}. `message` is always a usable string,
 * so a call site can render it without a fallback of its own; the rest are
 * `undefined` when the backend did not send them.
 */
export interface WebbPulseErrorInfo {
  /** The envelope's message, or the best line the other shapes yield. */
  message: string;
  /** `error_code` when the service enabled it. */
  errorCode: string | undefined;
  /** `details` when the service enabled it. */
  details: unknown[] | Record<string, unknown> | undefined;
  /**
   * The request id.
   *
   * Read from the envelope's `request_id` first and from the response header
   * second. The two agree in practice, since the same middleware writes both,
   * and preferring the body means a logged or forwarded body still carries it.
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
  // The WebbPulse envelope first. Its `message` is the field the backend wrote
  // for a caller to read, and a body carrying `success: false` never also
  // carries a meaningful `detail`, so there is nothing to fall through to.
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
 * Statuses on which a `Retry-After` header is read.
 *
 * The same set `client.ts` retries on, and the overlap is the point: the header
 * is only useful where a caller might try again, and reading it on a 404 would
 * put a number in front of a call site that has nothing to do with it. RFC 9110
 * allows the header on a 3xx redirect as well, which this deliberately skips:
 * `fetch` follows redirects itself, so a 3xx never reaches here as an error.
 */
const RETRY_AFTER_STATUSES: ReadonlySet<number> = new Set([
  408, 425, 429, 500, 502, 503, 504,
]);

/**
 * Parses a `Retry-After` header value into whole seconds.
 *
 * Handles both forms RFC 9110 section 10.2.3 defines:
 *
 * - **delta-seconds**, a non-negative decimal integer such as `120`. Taken as
 *   it stands. A value with a sign, a decimal point or trailing text is refused
 *   rather than coerced, because `Number('12abc')` is `NaN` but `Number(' 12 ')`
 *   is `12`, and quietly accepting the whitespace form while refusing the other
 *   is a distinction nobody meant to draw.
 * - **HTTP-date**, such as `Wed, 21 Oct 2026 07:28:00 GMT`. Converted to the
 *   seconds between `now` and that instant, rounded up so a sub-second wait
 *   does not read as no wait at all, and floored at zero so a date already past
 *   reads as `0`.
 *
 * `now` is injectable for the tests. It defaults to `Date.now()`, which is the
 * client's clock: an HTTP-date is only as good as the skew between the two
 * machines, which is why the header's own specification prefers delta-seconds.
 *
 * Returns `undefined` for an absent, empty or unparseable value, so a caller
 * that cannot read a hint is in the same position as one the server sent none.
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
  // An HTTP-date in any of RFC 9110's three formats carries a weekday and a
  // month name, so requiring a letter is what tells one apart from a number
  // that is not delta-seconds. Without this guard `Date.parse('-5')` succeeds
  // in Node, reading a malformed delta as the year 5 BCE and handing the caller
  // a wait of several millennia.
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
 *
 * Split from {@link parseRetryAfter} so the status gate lives beside the set
 * that defines it rather than at the one call site in `client.ts`.
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
   * Value of the request id response header, when the API returned one.
   *
   * The backend assigns a uuid7 request id per request. Surfacing it here is
   * what makes a browser side error report joinable to the CloudWatch logs and
   * the OpenTelemetry trace for the same request.
   */
  readonly requestId: string | undefined;
  /**
   * Seconds to wait before retrying, read off the `Retry-After` header.
   *
   * Set on the statuses this client already treats as worth a second attempt
   * and where RFC 9110 says the header means something: 429, 503, and the two
   * other retryable 4xx statuses, 408 and 425. It is `undefined` everywhere
   * else, and `undefined` on those statuses too when the server sent no header
   * or sent one this cannot read.
   *
   * Both RFC 9110 forms are accepted. `Retry-After: 120` is delta-seconds and
   * is taken as it stands; `Retry-After: Wed, 21 Oct 2026 07:28:00 GMT` is an
   * HTTP-date and is turned into the seconds between the client's clock and
   * that instant, floored at zero, so a date already in the past reads as 0
   * rather than as a negative wait. A skewed client clock therefore shifts the
   * wait, which is the trade every HTTP-date consumer makes and is why servers
   * are advised to send delta-seconds.
   *
   * This is a hint and not a promise. Treat it as a floor on how long to wait,
   * and keep whatever backoff the call site already has for the case where it
   * is absent.
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

/**
 * Reads the WebbPulse error envelope off an `ApiError`.
 *
 * This is the accessor an application uses instead of reaching into
 * `error.body` and re-implementing the shape check. It always returns a value:
 * `message` falls back through the same chain `formatApiErrorMessage` walks, so
 * a call site renders `getWebbPulseError(error).message` without a fallback of
 * its own, and `errorCode` is `undefined` rather than absent when the backend
 * did not send one, which is what lets a `switch` on it be exhaustive.
 *
 * Returning a flat object rather than the envelope itself is deliberate. The
 * body is snake case because Python wrote it, and the two consumers should not
 * both have to remember that `request_id` is the spelling on this one object
 * when every other field they touch is camel case. It also lets `requestId`
 * fall back to the response header, which the body cannot do.
 *
 * @example
 * ```ts
 * try {
 *   await client.post('/build-lists', body);
 * } catch (error) {
 *   if (error instanceof ApiError) {
 *     const { message, errorCode } = getWebbPulseError(error);
 *     if (errorCode === 'DUPLICATE_NAME') {
 *       setFieldError('name', message);
 *     } else {
 *       toast.error(message);
 *     }
 *   }
 * }
 * ```
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
      // The body's own id first, the header second. They are written by the
      // same middleware from the same value, so this is a fallback rather than
      // a choice between two sources of truth.
      requestId: body.request_id || error.requestId,
      status: error.status,
    };
  }
  // Not an envelope. Everything the envelope carries beyond the message is
  // absent by definition, and the message comes from the FastAPI `detail` or
  // bare `message` handling that was already here.
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
