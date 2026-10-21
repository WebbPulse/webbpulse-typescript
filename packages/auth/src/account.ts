/**
 * Self-service account calls: the signed-in user's session list and the
 * sign-in address change. The client side of webbpulse's `/sessions` and
 * `/email/change` routes. Every method resolves to an outcome for the refusals
 * a settings form renders inline, and rethrows anything else.
 */

import { ApiError, getWebbPulseError } from '@webbpulse/api-client';

import { type AuthErrorCode, getAuthErrorCode } from './errors.js';
import { retryAfterSeconds } from './email-flows.js';

/**
 * The SPA path an email change link lands on. Must equal the backend's
 * `EMAIL_CHANGE_LINK_PATH`, which it concatenates onto `frontend_base_url`.
 */
export const VERIFY_EMAIL_CHANGE_PATH = '/verify-email-change';

/** Where the account routes live, relative to the base URL. */
export interface AccountPaths {
  /** Defaults to `/api/auth/sessions`. */
  sessions?: string;
  /** Defaults to `/api/auth/email/change`. */
  emailChange?: string;
  /** Defaults to `/api/auth/email/change/confirm`. */
  emailChangeConfirm?: string;
}

/** One live sign-in, as the session list reports it. */
export interface AccountSession {
  /** The session id, which is the refresh family and the token's `sid` claim. */
  id: string;
  /** A coarse device class: `desktop`, `mobile`, `bot`, `other` or `unknown`. */
  device: string;
  /** The address the sign-in was first seen from, or an empty string. */
  ip: string;
  /** When the sign-in happened, as an ISO 8601 string. */
  startedAt: string;
  /** When the session last refreshed, as an ISO 8601 string. */
  lastActiveAt: string;
  /** When the current refresh token expires, in epoch seconds, or null. */
  expiresAt: number | null;
  /** How the sign-in authenticated, such as `pwd`, `otp` or `passkey`. */
  amr: string[];
  /** True for the session making the call. */
  current: boolean;
}

/** The fields every account refusal carries. */
interface RefusalFields {
  ok: false;
  code: AuthErrorCode | undefined;
  message: string;
}

/** A rate limit on the email change routes. */
export interface AccountRateLimited extends RefusalFields {
  reason: 'rate-limited';
  /** Seconds to wait before retrying, when the body carried a hint. */
  retryAfter: number | undefined;
}

/** A session id that is not one of the caller's live sessions. */
export interface SessionNotFound extends RefusalFields {
  reason: 'not-found';
}

/** The session making the call, which `logout` ends instead. */
export interface CurrentSession extends RefusalFields {
  reason: 'current-session';
}

/** A malformed address. */
export interface EmailInvalid extends RefusalFields {
  reason: 'invalid-email';
}

/** The address the account already signs in with. */
export interface EmailUnchanged extends RefusalFields {
  reason: 'unchanged';
}

/** An address another account holds. */
export interface EmailTaken extends RefusalFields {
  reason: 'taken';
}

/**
 * A sign-in older than the change window. Answer it with a step-up, then try
 * again. `maxAge` is the window in seconds, when the server sent it.
 */
export interface EmailChangeStepUpRequired extends RefusalFields {
  reason: 'step-up-required';
  maxAge: number | undefined;
}

/**
 * A deployment that cannot change addresses: no sender, no link store, or
 * product hooks with no `change_email`.
 */
export interface EmailChangeUnavailable extends RefusalFields {
  reason: 'unavailable';
}

/** A change link that is unknown, expired, already used or of another purpose. */
export interface EmailChangeLinkInvalid extends RefusalFields {
  reason: 'invalid-link';
}

/** Every refusal the account routes can produce. */
export type AccountRefusal =
  | AccountRateLimited
  | SessionNotFound
  | CurrentSession
  | EmailInvalid
  | EmailUnchanged
  | EmailTaken
  | EmailChangeStepUpRequired
  | EmailChangeUnavailable
  | EmailChangeLinkInvalid;

/** What {@link AuthClient.listSessions} resolves to. */
export type SessionListOutcome = { ok: true; sessions: AccountSession[] };

/** What {@link AuthClient.revokeSession} resolves to. */
export type SessionRevokeOutcome =
  { ok: true } | SessionNotFound | CurrentSession;

/** What {@link AuthClient.requestEmailChange} resolves to. */
export type EmailChangeRequestOutcome =
  | { ok: true }
  | EmailInvalid
  | EmailUnchanged
  | EmailTaken
  | EmailChangeStepUpRequired
  | EmailChangeUnavailable
  | AccountRateLimited;

/** What {@link AuthClient.confirmEmailChange} resolves to. */
export type EmailChangeConfirmOutcome =
  | { ok: true }
  | EmailChangeLinkInvalid
  | EmailTaken
  | EmailChangeUnavailable
  | AccountRateLimited;

/**
 * Reads the session list body into {@link AccountSession} values, dropping
 * entries with no id. An unexpected body is an empty list.
 */
export function parseAccountSessions(body: unknown): AccountSession[] {
  const raw = (body as { sessions?: unknown } | null)?.sessions;
  if (!Array.isArray(raw)) {
    return [];
  }
  const sessions: AccountSession[] = [];
  for (const entry of raw as unknown[]) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const id = item['id'];
    if (typeof id !== 'string' || id === '') {
      continue;
    }
    const expires = item['expires_at'];
    sessions.push({
      id,
      device: text(item['device']),
      ip: text(item['ip']),
      startedAt: text(item['started_at']),
      lastActiveAt: text(item['last_active_at']),
      expiresAt:
        typeof expires === 'number' && Number.isFinite(expires)
          ? expires
          : null,
      amr: Array.isArray(item['amr'])
        ? (item['amr'] as unknown[]).filter(
            (value): value is string => typeof value === 'string'
          )
        : [],
      current: item['current'] === true,
    });
  }
  return sessions;
}

/** A string field, or an empty string for anything else. */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Classifies a thrown error from one of the account routes, or returns null so
 * the caller rethrows. `expected` keeps a code that is an outcome on one route
 * from becoming a silent success on another.
 */
export function classifyAccountError<
  TReason extends AccountRefusal['reason'],
  TRefusal extends AccountRefusal = Extract<
    AccountRefusal,
    { reason: TReason }
  >,
>(error: unknown, expected: ReadonlySet<TReason>): TRefusal | null {
  return classify(error, expected) as TRefusal | null;
}

/** The server error code each modelled refusal answers to. */
const REASON_BY_CODE: Readonly<
  Record<string, Exclude<AccountRefusal['reason'], 'rate-limited'>>
> = {
  SESSION_NOT_FOUND: 'not-found',
  CURRENT_SESSION: 'current-session',
  INVALID_EMAIL: 'invalid-email',
  EMAIL_UNCHANGED: 'unchanged',
  EMAIL_TAKEN: 'taken',
  STEP_UP_REQUIRED: 'step-up-required',
  EMAIL_CHANGE_UNSUPPORTED: 'unavailable',
  EMAIL_NOT_CONFIGURED: 'unavailable',
  INVALID_LINK: 'invalid-link',
};

/**
 * The untyped body of {@link classifyAccountError}, holding the one cast
 * TypeScript needs because it cannot prove a concrete reason satisfies an
 * unresolved `TReason`.
 */
function classify(
  error: unknown,
  expected: ReadonlySet<AccountRefusal['reason']>
): AccountRefusal | null {
  if (!(error instanceof ApiError)) {
    return null;
  }
  const envelope = getWebbPulseError(error);
  const base = {
    ok: false as const,
    code: getAuthErrorCode(error),
    message: envelope.message,
  };
  if (error.status === 429 && expected.has('rate-limited')) {
    return {
      ...base,
      reason: 'rate-limited',
      retryAfter: retryAfterSeconds(error),
    };
  }
  const reason =
    envelope.errorCode === undefined
      ? undefined
      : REASON_BY_CODE[envelope.errorCode];
  if (reason === undefined || !expected.has(reason)) {
    return null;
  }
  if (reason === 'step-up-required') {
    return { ...base, reason, maxAge: maxAgeFrom(envelope.details) };
  }
  return { ...base, reason };
}

/** The `max_age` a step-up refusal carries in its details, in seconds. */
function maxAgeFrom(details: unknown): number | undefined {
  if (
    details === null ||
    typeof details !== 'object' ||
    Array.isArray(details)
  ) {
    return undefined;
  }
  const value = (details as Record<string, unknown>)['max_age'];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}
