---
'@webbpulse/eslint-config': minor
'@webbpulse/api-client': minor
'@webbpulse/tsconfig': minor
'@webbpulse/config': minor
'@webbpulse/auth': minor
---

WebAuthn passkeys in `@webbpulse/auth`, matching the identity service's seven
passkey routes.

`registerPasskey` and `signInWithPasskey` each run a whole ceremony: fetch the
options, call `navigator.credentials`, post the result back. Both legs live in
one method because the challenge is a single-use row on the server, spent by one
attempt whatever the outcome, and because the `challenge_id` the options route
returns alongside the WebAuthn document is the server's own handle and must
never reach the browser. A retry therefore starts again from the options leg,
which is what calling the method again does naturally.

`signInWithPasskey` takes an optional email and omits it for the discoverable,
passwordless case. It resolves to either a session or an MFA challenge, since a
passkey used without user verification on an account with a second factor
enrolled leaves the login half done; that ticket is finished with the existing
`completeTotp`, so there is no second passkey-specific method to learn.
`listPasskeys`, `renamePasskey` and `deletePasskey` cover a settings page.

Refusals a page has to render inline are outcomes rather than exceptions, on the
rule the link, MFA and OAuth flows already follow: `rejected` for the one answer
every failed ceremony gets, `already-registered`, `not-found`, `name-required`,
`unavailable` for a deployment with passkeys or passwordless sign-in switched
off, `rate-limited`, and `last-credential` for the delete that would strand a
user with no password outside their own account. A dismissed browser prompt is a
`cancelled` outcome too, because pressing Cancel is not a failure.

`passkeysSupported` and `conditionalMediationAvailable` are the feature checks a
sign-in page needs before it renders a button or arms autofill.
`base64UrlToBuffer`, `bufferToBase64Url`, `toCreationOptions`, `toRequestOptions`
and `credentialToJSON` are the conversion layer, used only when the browser
lacks the native `parseCreationOptionsFromJSON`, `parseRequestOptionsFromJSON`
and `toJSON`; they touch exactly the fields the specification declares as
`BufferSource`, so an option this version has never heard of still reaches the
browser unchanged. `navigator.credentials` is injectable through a
`WebAuthnAdapter` so a test never needs an authenticator.

`AUTH_ERROR_CODES` gains the nine codes the passkey routes emit. The 0.7.0
`loginWithPasskey` and `completePasskeyMfa` are gone: they were written against
a route shape the server does not serve.
