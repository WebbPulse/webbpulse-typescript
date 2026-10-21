---
'@webbpulse/auth': minor
---

Session list and sign-in address change, the client side of webbpulse 0.95.0's `/sessions` and `/email/change` routes (STUP-293). `AuthClient.listSessions()` lists the signed-in user's live sessions as `AccountSession` values with the calling one marked `current`. `revokeSession(id)` ends another one and resolves `not-found` or `current-session` rather than throwing. `requestEmailChange({ email })` mails a link to the new address and resolves `invalid-email`, `unchanged`, `taken`, `step-up-required` (with `maxAge`), `unavailable` or `rate-limited`. `confirmEmailChange({ token })` spends that link from the `VERIFY_EMAIL_CHANGE_PATH` landing page. All four are also on `useAuth()`. New `AuthPaths` entries are `sessions`, `emailChange` and `emailChangeConfirm`. `SESSION_NOT_FOUND`, `CURRENT_SESSION`, `INVALID_EMAIL`, `EMAIL_UNCHANGED`, `EMAIL_TAKEN` and `EMAIL_CHANGE_UNSUPPORTED` join `AUTH_ERROR_CODES`.
