---
'@webbpulse/auth': minor
'@webbpulse/api-client': minor
'@webbpulse/config': minor
---

Hoists frontend helpers the products each carried a copy of. `@webbpulse/auth` adds `safeReturnPath` and `isSafeReturnPath`, which accept only a root relative path and refuse `//host`, backslashes, control characters, schemes and percent-encoded variants of them, and `identityReturnUrl`, which accepts an absolute URL back to one exact identity route on the identity origin. `@webbpulse/api-client` adds `getErrorCode(error: unknown)`, the envelope `error_code` or `undefined`. `@webbpulse/config` adds the `loadAppConfig` options `apiBaseUrlAliases`, further variable names read when `VITE_API_BASE_URL` is blank, and `assumeHttps`, which gives a bare host an `https://` scheme. All additive; existing calls behave as before.
