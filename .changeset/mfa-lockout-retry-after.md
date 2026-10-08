---
'@webbpulse/auth': patch
---

MFA route `rate-limited` outcomes read `retryAfter` from the `Retry-After` header first, then the body. A second-factor lockout (`TOO_MANY_ATTEMPTS`) sends only the header, so `stepUp({ code })`, `disableTotp` and `regenerateRecoveryCodes` used to report no wait.
