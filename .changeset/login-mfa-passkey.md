---
'@webbpulse/auth': minor
---

Answer a login MFA challenge with a passkey. `AuthClient.completeMfaWithPasskey({ ticket })`, also on `useAuth()`, runs the options leg with the MFA ticket, the WebAuthn ceremony and the verify leg, then stores the session exactly as `completeTotp` does. It resolves to a `PasskeyMfaOutcome` rather than throwing for `rejected`, `ticket-invalid`, `unavailable`, `no-passkeys`, `rate-limited`, `cancelled` and `unsupported`. New `PasskeyPaths` entries `loginMfaPasskeyOptions` and `loginMfaPasskeyVerify` default to `/api/auth/login/mfa/passkey/options` and `/api/auth/login/mfa/passkey/verify`. `PASSKEY_FACTOR` (`'passkey'`) sits beside `TOTP_FACTOR` for reading `factors`, and `PASSKEY_FACTOR_DISABLED` joins `AUTH_ERROR_CODES`.
