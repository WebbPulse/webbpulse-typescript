---
'@webbpulse/auth': minor
---

Model an unsupported passkey ceremony, and add a passkey step-up.

A browser that accepts the support probes and then refuses
`navigator.credentials.get` no longer escapes as an unhandled rejection. A
`DOMException` named `NotSupportedError`, which headless Chromium raises for a
discoverable credential, and every browser-side rejection of a
`mediation: 'conditional'` ceremony now settle as a new `unsupported` refusal,
leaving `state.error` null. An autofill sign-in armed on mount needs no
`.catch`. `cancelled` is unchanged, and registration models `unsupported` too.

`stepUpWithPasskey` gates a sensitive action on a passkey rather than a typed
code: an options leg scoped to the signed-in caller at
`stepUpPasskeyOptions`, then the ordinary step-up route for the assertion,
adopting the fresher token exactly as `stepUp` does. An account with no passkey
answers the new `no-passkeys` refusal. `stepUp` and `stepUpWithPasskey` are now
exposed on `useAuth`.
