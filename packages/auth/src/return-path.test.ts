import { describe, expect, it } from 'vitest';
import {
  identityReturnUrl,
  isSafeReturnPath,
  safeReturnPath,
} from './return-path.js';

describe('safeReturnPath', () => {
  it.each([
    '/',
    '/workspaces',
    '/workspaces/acme/issues?status=open#top',
    '/invites/accept?token=abc-123_XYZ',
    '/login?returnTo=https%3A%2F%2Fapi.example.com%2Fapi%2Fauth%2Fauthorize',
    '/search?q=a%20b',
  ])('keeps the local path %s', (value) => {
    expect(safeReturnPath(value, '/home')).toBe(value);
  });

  it.each([
    null,
    undefined,
    '',
    42,
    'workspaces',
    '//evil.example',
    '///evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    '/\\/evil.example',
    '/x\\y',
    '/\t/evil.example',
    '/\n/evil.example',
    '/\u0000/evil.example',
    'https://evil.example',
    'http:evil.example',
    'javascript:alert(1)',
    ' /workspaces',
    '%2F%2Fevil.example',
    '/%2Fevil.example',
    '/%2F%2Fevil.example',
    '/%5Cevil.example',
    '/%5C%5Cevil.example',
    '/%09/evil.example',
    '/%252F%252Fevil.example',
    '/%25252F%25252Fevil.example',
    '/%2525252Fevil.example',
    '/%E0%A4%A',
  ])('falls back for %j', (value) => {
    expect(safeReturnPath(value, '/home')).toBe('/home');
  });

  it('falls back to the root by default', () => {
    expect(safeReturnPath('//evil.example')).toBe('/');
  });

  it('refuses an excluded pathname with or without a query', () => {
    const options = { excludePaths: ['/sign-in'] };
    expect(safeReturnPath('/sign-in', '/workspaces', options)).toBe(
      '/workspaces'
    );
    expect(safeReturnPath('/sign-in?next=x', '/workspaces', options)).toBe(
      '/workspaces'
    );
    expect(safeReturnPath('/sign-in/help', '/workspaces', options)).toBe(
      '/sign-in/help'
    );
  });

  it('narrows the value as a type guard', () => {
    const value: unknown = '/workspaces';
    expect(isSafeReturnPath(value)).toBe(true);
    expect(isSafeReturnPath('//evil.example')).toBe(false);
  });
});

describe('identityReturnUrl', () => {
  const authorize =
    'https://api.example.com/api/auth/authorize?client_id=x&state=y';
  const options = {
    identityOrigin: 'https://api.example.com',
    path: '/api/auth/authorize',
  };

  it('returns the URL on the identity origin at the exact path', () => {
    expect(identityReturnUrl(authorize, options)).toBe(authorize);
  });

  it.each([
    null,
    undefined,
    '',
    '/api/auth/authorize',
    'not a url',
    'https://evil.example/api/auth/authorize',
    'http://api.example.com/api/auth/authorize',
    'https://api.example.com:8443/api/auth/authorize',
    'https://api.example.com/api/auth/authorize/extra',
    'https://api.example.com/api/auth/other',
    'https://user:pass@api.example.com/api/auth/authorize',
    'https://api.example.com/api/auth/authorize#frag',
    'javascript://api.example.com/api/auth/authorize',
  ])('refuses %j', (value) => {
    expect(identityReturnUrl(value, options)).toBeNull();
  });

  it('uses the page origin for an empty identity origin', () => {
    const pageOptions = {
      identityOrigin: '',
      path: '/api/auth/device',
      pageOrigin: 'https://app.example.com',
    };
    expect(
      identityReturnUrl(
        'https://app.example.com/api/auth/device?user_code=AB',
        pageOptions
      )
    ).toBe('https://app.example.com/api/auth/device?user_code=AB');
    expect(
      identityReturnUrl('https://evil.example/api/auth/device', pageOptions)
    ).toBeNull();
  });

  it('uses the page origin for a root relative identity origin', () => {
    expect(
      identityReturnUrl('https://app.example.com/api/auth/device', {
        identityOrigin: '/api/v1',
        path: '/api/auth/device',
        pageOrigin: 'https://app.example.com',
      })
    ).toBe('https://app.example.com/api/auth/device');
  });

  it('refuses everything when no origin can be resolved', () => {
    expect(
      identityReturnUrl('https://app.example.com/api/auth/device', {
        identityOrigin: '',
        path: '/api/auth/device',
      })
    ).toBeNull();
  });
});
