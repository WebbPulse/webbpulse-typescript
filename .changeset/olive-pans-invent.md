---
'@webbpulse/auth': minor
---

Share the identity client singleton and the sign-in controls' behaviour.

`@webbpulse/auth/browser` is a new entry point holding
`createIdentityClientSingleton`, the lazy `createAuthClient` build every product
had copied: the origin derivation, the `credentials: 'include'` and 30 second
client options, the current-user load, and the `setWebAuthnAdapterForTests` and
`resetForTests` seams. `apiBaseUrl` takes a thunk so a test that restubs the
environment and resets gets a client built from the new value.
`identityOriginFrom` and `identityUrl` ship from the same entry, carried rather
than imported because `@webbpulse/discovery` already depends on this package.

`@webbpulse/auth/react` gains two headless hooks matching the `/panels`
precedent. `usePasskeySignInButton` is the support gate, the aborted conditional
ceremony and the click handler in one, and `useOAuthProviderLinks` turns a
provider list into built start URLs. Both return state and handlers only, so a
product keeps its own markup, classes and copy.
