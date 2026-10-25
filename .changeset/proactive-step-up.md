---
'@webbpulse/auth': minor
---

`useStepUp({ mode: 'proactive' })` from `@webbpulse/auth/react` asks for a fresh proof of identity before a sensitive call, with no `STEP_UP_REQUIRED` refusal parked (PLAT-98). `prove(method)` runs the step-up and resolves true once proven. A passkey that cannot be used moves `stage` to `code` instead of failing, `skip()` marks an account with no second factor done, `reset()` starts over, and a `rate-limited` code or password sets `locked` with the wait in `lockedFor`. `useStepUp()` keeps the reactive gate unchanged. New types `ProactiveStepUp`, `ProactiveStepUpOptions`, `ProactiveStepUpStage` and `ReactiveStepUpOptions`.
