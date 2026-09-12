# @webbpulse/discovery

What a deployment of the identity service can actually do, read before a sign-in
page decides what to render. Both applications wrote this separately and
disagreed on the two decisions that matter, which is what this package settles.

```ts
import {
  PASSKEY_AVAILABILITY_PATH,
  identityOriginFrom,
  identityUrl,
  passkeyLoginAvailability,
} from '@webbpulse/discovery';

const origin = identityOriginFrom(config.apiBaseUrl);
const offered = await passkeyLoginAvailability(
  identityUrl(origin, PASSKEY_AVAILABILITY_PATH)
);

if (offered === 'available') {
  // draw the passkey button
}
```

## Tri-state, not boolean

`Availability` is `'available' | 'unavailable' | 'unknown'`. A read that could
not be made is `unknown`, which is not `unavailable`: the first is the page
knowing nothing, the second is the deployment saying no. Collapsing them to a
boolean means a dropped request renders the same as a switched-off capability,
and a page that then hides the affordance has decided something on behalf of a
server it never reached.

Every failure mode answers `unknown`: a network error, a 404 from a backend older
than the route, any non-200, a body that is not JSON, and a 200 whose fields are
not the two booleans. Only a 200 with the documented shape is an answer.

## One read per page load

`cachedAvailability` keys on the **full URL**, which folds the API origin into
the key, so two bundles pointed at different backends cannot share an answer. It
stores the in-flight promise rather than the result, so a login page and a
settings panel mounting on the same paint make one request between them.

An `unknown` answer is evicted, so a flaky read is retried on the next ask. An
`available` or `unavailable` answer is kept, because it is a fact about the
deployment and will not change under the page. A deployment with no OAuth
providers configured is `unavailable` and therefore cached: "none" is an answer.

`resetAvailabilityCache()` empties the promise cache and every answer memoised
beside it. One function rather than one per gate, so a test cannot reset half of
the state and then see a stale answer.

## Full URLs, and the relative base URL question

Every network function takes the **whole URL** and an optional `fetchImpl`,
defaulting to `globalThis.fetch`. Taking an origin and appending the path
internally hides the key the cache uses, and an injectable `fetch` is what lets
these be tested without a network.

`identityOriginFrom(apiBaseUrl)` strips an API base URL back to its origin, since
the discovery paths are already absolute and a `/api` base would otherwise send
reads to `/api/api/auth/...`. A root relative base such as `/api` has two
defensible answers and the applications picked different ones, so it is an
option: `relativeAs: 'empty'`, the default, yields `''` and `identityUrl` then
builds a path the browser resolves against the current origin;
`relativeAs: 'passthrough'` returns the base URL unchanged.

## `displayName`, not `display_name`

The route sends `display_name`. `OAuthProviderInfo` carries `displayName`,
because snake_case is the backend's convention at the wire and this is a
TypeScript surface. `parseProviders` does the renaming, drops each entry without
a usable `id` individually so one malformed record cannot hide the rest, and
falls back to `providerLabel` when the server sent no name.

`providerLabel` takes the two baseline ids from `GOOGLE_PROVIDER` and
`GITHUB_PROVIDER` in `@webbpulse/auth` rather than restating the strings, so the
label table and the provider constants cannot drift apart. That is the whole
reason this package depends on `@webbpulse/auth`.

## Exports

Availability and URLs: `Availability`, `cachedAvailability`,
`resetAvailabilityCache`, `identityOriginFrom`, `identityUrl`,
`IdentityOriginOptions`.

Passkeys: `PASSKEY_AVAILABILITY_PATH`, `PasskeyCapabilities`,
`parsePasskeyCapabilities`, `passkeyCapabilities`, `passkeyLoginAvailability`,
`passkeyEnrolmentAvailability`. The last three share one request, so a page that
asks both whether to offer a passkey button and whether to offer enrolment costs
one read.

OAuth: `OAUTH_PROVIDERS_PATH`, `OAuthProviderInfo`, `providerLabel`,
`parseProviders`, `oauthProviders`.
