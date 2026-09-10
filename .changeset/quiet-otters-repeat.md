---
'@webbpulse/api-client': minor
'@webbpulse/auth': minor
'@webbpulse/config': minor
'@webbpulse/eslint-config': minor
'@webbpulse/tsconfig': minor
---

Add the TOTP, recovery code and step-up flows to `@webbpulse/auth`.

`AuthClient` gains five methods for the identity service's M4 routes, all of
them behind the authorizer and all of them carrying the bearer token from this
client, so they inherit its refresh-once behaviour on a 401: `enrolTotp`,
`activateTotp`, `disableTotp`, `regenerateRecoveryCodes` and `stepUp`. The two
legs of an MFA sign in, `login` and `completeTotp`, already existed and are
unchanged.

**These five return outcomes rather than throwing**, in the style of the M3 link
flows and for a sharper version of the same reason: a user mistyping a six digit
code is the single most likely thing to happen with an activation form open, and
putting that in a `catch` puts the common path in the handler. They reject only
for a network failure, a 500, or a 401 the client could not repair, which is the
session ending rather than a form field error.

`enrolTotp` returns the base32 seed and the `otpauth://` provisioning URI, once.
There is no route that reads a seed back, so a user who loses it before
activating enrols again and gets a new one. This package renders no QR code and
adds no dependency to do it: hand `provisioningUri` to whatever generator the
product already has. `activateTotp` returns the ten recovery codes the server
issues with the activation, also once, since the server stores only their
hashes. `regenerateRecoveryCodes` replaces the set and invalidates every
previous code, which is the point of regenerating.

`stepUp` is not a second login. No refresh family is started and the refresh
cookie is untouched, because the session is not new. What changes on the new
token is `auth_time`, which becomes now, and `amr`, which gains the factor just
satisfied. The token is adopted into the client's in-memory store and the
proactive refresh timer is re-armed against it, so the next request carries it
with no work at the call site; it is not in the outcome, because there is
exactly one place an access token lives.

`invalid-code` is deliberately one refusal covering a wrong code, a replayed
code, no factor enrolled, a factor enrolled but not activated, a spent recovery
code and one that never existed. The server answers all six identically so the
second leg of login cannot be used to discover which accounts have TOTP enabled,
and a client that split them would be inventing information it does not have.

`AUTH_ERROR_CODES` appends the six codes the MFA routes emit: `INVALID_MFA_CODE`,
`MFA_TICKET_INVALID`, `TOTP_ALREADY_ENABLED`, `NO_PENDING_ENROLMENT`,
`MFA_NOT_CONFIGURED` and `NOT_AUTHENTICATED`. The twelve from section 7.3 and
the five from M3 keep their order, which a test asserts as a prefix.

`AuthPaths` gains `totpEnrol`, `totpActivate`, `totpDisable`, `recoveryCodes`
and `stepUp`, defaulting to the standard's `/api/auth` issuer path.

No breaking changes. Everything that existed in 0.5.0 keeps its shape.
