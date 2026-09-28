---
'@webbpulse/api-client': minor
'@webbpulse/auth': minor
---

Step-up gate. `@webbpulse/api-client` classifies a 401 carrying `STEP_UP_REQUIRED` (or `WWW-Authenticate: Bearer error="insufficient_user_authentication"`) as a `StepUpRequiredError` with `maxAge`, which skips the refresh and replay and does not call `onUnauthorized`; adds `isStepUpRequired`, `apiErrorFromResponse` and `STEP_UP_REQUIRED_ERROR_CODE`, and `reset()` on `useMutationWithRefetch`. `@webbpulse/auth` adds `stepUp({ password })`, `authTime()` and `isRecentlyAuthenticated(maxAgeSeconds)` (also on `useAuth`), `StepUpCancelledError` and `classifyPasswordStepUpError`, and the headless `useStepUp` hook in `@webbpulse/auth/react` with `withStepUp`, `submit`, `cancel`, `open`, `maxAge`, `pending` and `error`.
