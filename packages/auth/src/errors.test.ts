import { ApiError } from '@webbpulse/api-client';
import { describe, expect, it } from 'vitest';

import {
  AUTH_ERROR_CODES,
  AuthSessionEndedError,
  describeAuthError,
  getAuthErrorCode,
  isAuthErrorCode,
} from './errors.js';

/** An `ApiError` carrying the backend's error envelope. */
function envelopeError(
  status: number,
  code: string | undefined,
  message = 'Denied.'
): ApiError {
  return new ApiError({
    status,
    statusText: 'Error',
    body: {
      success: false,
      status,
      message,
      request_id: 'req_test',
      ...(code === undefined ? {} : { error_code: code }),
    },
    url: 'https://api.example.test/api/auth/login',
    method: 'POST',
  });
}

describe('AUTH_ERROR_CODES', () => {
  it('opens with exactly the twelve codes section 7.3 names, in order', () => {
    expect([...AUTH_ERROR_CODES].slice(0, 12)).toEqual([
      'MFA_REQUIRED',
      'INVALID_CREDENTIALS',
      'ACCOUNT_LOCKED',
      'EMAIL_NOT_VERIFIED',
      'TOKEN_EXPIRED',
      'INVALID_TOKEN',
      'SESSION_REVOKED',
      'RATE_LIMITED',
      'WEAK_PASSWORD',
      'PASSWORD_TOO_LONG',
      'OAUTH_EMAIL_UNVERIFIED',
      'PASSKEY_NOT_RECOGNISED',
    ]);
  });

  it('adds the codes the M3 link flows emit', () => {
    expect([...AUTH_ERROR_CODES].slice(12, 17)).toEqual([
      'INVALID_LINK',
      'PASSWORD_TOO_SHORT',
      'PASSWORD_REJECTED',
      'TOO_MANY_ATTEMPTS',
      'EMAIL_NOT_CONFIGURED',
    ]);
  });

  it('adds the codes the M4 MFA routes emit', () => {
    expect([...AUTH_ERROR_CODES].slice(17, 23)).toEqual([
      'INVALID_MFA_CODE',
      'MFA_TICKET_INVALID',
      'TOTP_ALREADY_ENABLED',
      'NO_PENDING_ENROLMENT',
      'MFA_NOT_CONFIGURED',
      'NOT_AUTHENTICATED',
    ]);
  });

  it('adds the codes the M6 OAuth routes emit', () => {
    expect([...AUTH_ERROR_CODES].slice(23, 39)).toEqual([
      'OAUTH_LAST_SIGN_IN_METHOD',
      'OAUTH_ALREADY_LINKED',
      'OAUTH_NOT_LINKED',
      'OAUTH_PROVIDER_UNKNOWN',
      'OAUTH_PROVIDER_UNAVAILABLE',
      'OAUTH_CANCELLED',
      'OAUTH_STATE_INVALID',
      'OAUTH_REDIRECT_NOT_ALLOWED',
      'OAUTH_EXCHANGE_FAILED',
      'OAUTH_USERINFO_FAILED',
      'OAUTH_ID_TOKEN_INVALID',
      'OAUTH_NONCE_MISMATCH',
      'OAUTH_CODE_MISSING',
      'OAUTH_EMAIL_MISSING',
      'OAUTH_ACCOUNT_MISSING',
      'REGISTRATION_DISABLED',
    ]);
  });

  it('adds the codes the M5 passkey routes emit', () => {
    expect([...AUTH_ERROR_CODES].slice(39)).toEqual([
      'PASSKEY_REJECTED',
      'PASSKEY_ALREADY_REGISTERED',
      'PASSKEY_NOT_FOUND',
      'PASSKEY_NAME_REQUIRED',
      'PASSKEY_CHALLENGE_INVALID',
      'PASSKEY_LOGIN_DISABLED',
      'PASSKEYS_DISABLED',
      'LAST_CREDENTIAL',
      'CREDENTIAL_REQUIRED',
    ]);
  });
});

describe('isAuthErrorCode', () => {
  it('accepts every code in the contract', () => {
    for (const code of AUTH_ERROR_CODES) {
      expect(isAuthErrorCode(code)).toBe(true);
    }
  });

  it('rejects a code from another domain and a non string', () => {
    expect(isAuthErrorCode('NOT_FOUND')).toBe(false);
    expect(isAuthErrorCode(undefined)).toBe(false);
    expect(isAuthErrorCode(401)).toBe(false);
  });
});

describe('getAuthErrorCode', () => {
  it('reads the code off the envelope', () => {
    expect(getAuthErrorCode(envelopeError(401, 'INVALID_CREDENTIALS'))).toBe(
      'INVALID_CREDENTIALS'
    );
  });

  it('returns undefined for a code the contract does not name', () => {
    expect(
      getAuthErrorCode(envelopeError(409, 'DUPLICATE_NAME'))
    ).toBeUndefined();
  });

  it('returns undefined when the backend sent no code', () => {
    expect(getAuthErrorCode(envelopeError(500, undefined))).toBeUndefined();
  });

  it('returns undefined for a body that is not an envelope', () => {
    const error = new ApiError({
      status: 401,
      statusText: 'Unauthorized',
      body: { detail: 'Not authenticated' },
      url: 'https://api.example.test/x',
      method: 'GET',
    });
    expect(getAuthErrorCode(error)).toBeUndefined();
  });

  it('returns undefined for a network failure', () => {
    expect(getAuthErrorCode(new Error('offline'))).toBeUndefined();
    expect(getAuthErrorCode('not an error')).toBeUndefined();
  });
});

describe('describeAuthError', () => {
  it('prefers the envelope message the backend wrote for a caller', () => {
    expect(
      describeAuthError(
        envelopeError(423, 'ACCOUNT_LOCKED', 'Too many attempts.')
      )
    ).toBe('Too many attempts.');
  });

  it('falls back to the error message for a plain error', () => {
    expect(describeAuthError(new Error('offline'))).toBe('offline');
  });

  it('falls back to the supplied line for a non error', () => {
    expect(describeAuthError({}, 'Nope.')).toBe('Nope.');
  });
});

describe('AuthSessionEndedError', () => {
  it('survives an instanceof check and carries its reason', () => {
    const error = new AuthSessionEndedError({
      reason: 'refresh-failed',
      code: 'SESSION_REVOKED',
    });
    expect(error).toBeInstanceOf(AuthSessionEndedError);
    expect(error).toBeInstanceOf(Error);
    expect(error.reason).toBe('refresh-failed');
    expect(error.code).toBe('SESSION_REVOKED');
    expect(error.name).toBe('AuthSessionEndedError');
  });

  it('has a default message', () => {
    expect(new AuthSessionEndedError({ reason: 'logged-out' }).message).toBe(
      'The session has ended.'
    );
  });
});
