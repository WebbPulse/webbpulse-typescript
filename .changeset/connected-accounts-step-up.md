---
'@webbpulse/auth': minor
---

`useConnectedAccountsPanel` from `@webbpulse/auth/panels` takes an optional `withStepUp` (PLAT-99), shaped like `StepUpGate['withStepUp']` from `useStepUp()`. `link` and `unlink` run through it, so a `STEP_UP_REQUIRED` refusal opens the step-up prompt and the call replays after the person re-authenticates. A `StepUpCancelledError` from the wrapped call settles as a cancellation: `busy` clears, no error banner shows, and nothing rejects. Without the option the panel calls the client directly as before.
