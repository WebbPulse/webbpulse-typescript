# webbpulse-typescript

Shared TypeScript packages for the WebbPulse applications, published to
CodeArtifact under the `@webbpulse` scope.

Two frontends consume these: CarModPicker and WebbPulse Portfolio. They arrived
at the same problems separately and solved them differently, and the point of
this repository is to have one answer to each rather than two. The backends are
splitting into one Lambda per domain behind a single HTTP API that routes by
path prefix, so the browser still sees one origin and a client organised by
domain is a client with one base URL and several prefixes.

## Contents

| Package                                              | What it is                                                |
| ---------------------------------------------------- | --------------------------------------------------------- |
| [`@webbpulse/api-client`](packages/api-client)       | Typed fetch client. Framework free.                       |
| [`@webbpulse/auth`](packages/auth)                   | Session helpers, with React bindings in a separate entry. |
| [`@webbpulse/config`](packages/config)               | Validated accessors over `import.meta.env`.               |
| [`@webbpulse/eslint-config`](packages/eslint-config) | Shared flat ESLint configurations.                        |
| [`@webbpulse/tsconfig`](packages/tsconfig)           | Shared compiler configurations.                           |

There is no `@webbpulse/ui`. See [below](#why-there-is-no-webbpulseui).

## Installing from CodeArtifact

The packages are private. Point npm at the CodeArtifact repository before
installing.

```bash
aws codeartifact login \
  --tool npm \
  --domain webbpulse \
  --domain-owner 432410731887 \
  --repository npm \
  --region us-west-2

npm install @webbpulse/api-client @webbpulse/auth @webbpulse/config
```

`login` writes the registry and a twelve hour token into `~/.npmrc`. For a
checkout that should carry the scope binding in version control instead, this
repository's [`.npmrc`](.npmrc) reads both values from the environment:

```bash
export CODEARTIFACT_DOMAIN_OWNER=432410731887
export CODEARTIFACT_REGISTRY_HOST="webbpulse-${CODEARTIFACT_DOMAIN_OWNER}.d.codeartifact.us-west-2.amazonaws.com/npm/npm/"
export CODEARTIFACT_AUTH_TOKEN=$(aws codeartifact get-authorization-token \
  --domain webbpulse --domain-owner "$CODEARTIFACT_DOMAIN_OWNER" \
  --region us-west-2 --query authorizationToken --output text)
```

In CI the token comes from OIDC. There are no personal tokens anywhere.

## Toolchain

Node 22, npm workspaces, TypeScript 5.8 strict, tsup emitting ESM plus type
declarations, Vitest, ESLint 9 flat config, Prettier, changesets.

This matches CarModPicker, which is the stricter of the two applications: Node
22 in its `.nvmrc`, npm with a `package-lock.json`, type checked ESLint rules
with the `no-unsafe-*` family promoted to errors, and coverage thresholds of
60/50/50/60. Portfolio runs Node 20 in CI and untyped ESLint rules. Converging
upward is deliberate. Source authored under the stricter settings compiles and
lints cleanly for both consumers, and the reverse is not true, so the looser
project cannot be the baseline.

Two divergences from the applications are worth naming:

- **ESM only.** Both applications are Vite bundled and neither needs CommonJS,
  so shipping a second format would be output nobody loads.
- **No Tailwind, React or Vite dependency in the core packages.** `api-client`
  and `config` import nothing beyond the standard library, and React is a
  peer dependency of `@webbpulse/auth` that only the `/react` entry point
  touches. This is what lets the packages be adopted before the applications
  agree on anything visual.

## Local development

```bash
npm install
npm run build        # tsup across every workspace
npm run type-check
npm run lint
npm run test:run
npm run test:run -- --coverage
```

`@webbpulse/auth` resolves `@webbpulse/api-client` through its built `dist`, so
run `npm run build` once after a fresh clone before type checking.

## Versioning

Changesets, with each package versioned independently.

```bash
npm run changeset          # record what changed and how much it moves
npm run version-packages   # apply pending changesets, update changelogs
```

Publishing happens on a `v*` tag through
[`.github/workflows/publish.yml`](.github/workflows/publish.yml). CI requires a
changeset on any pull request touching `packages/`. The reasoning behind
independent versioning, and where it departs from the platform migration
design, is in [`.changeset/README.md`](.changeset/README.md).

### Required repository configuration

Both workflows call the organisation's reusable workflows in
`WebbPulse/.github`.

| Secret                          | Used by       | What it is                                                                                                                                                                                                                              |
| ------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CODEARTIFACT_PUBLISH_ROLE_ARN` | `publish.yml` | IAM role ARN in the Platform account, assumed via OIDC, allowed to publish to the `npm` repository. Its trust policy should admit only `repo:WebbPulse/webbpulse-typescript:ref:refs/tags/v*`, so a pull request branch cannot publish. |
| `CODEARTIFACT_DOMAIN_OWNER`     | `publish.yml` | AWS account id owning the CodeArtifact domain: `432410731887`.                                                                                                                                                                          |

A GitHub Environment named `publish` gates the publish job. Add required
reviewers there if a release should need approval. `ci.yml` needs no secrets:
this repository publishes the `@webbpulse` scope rather than consuming it, so
every dependency resolves from the public registry.

Domain `webbpulse`, repository `npm`, region `us-west-2`, account
`432410731887`.

## The packages

### `@webbpulse/api-client`

```ts
import { createApiClient, ApiError } from '@webbpulse/api-client';

const client = createApiClient({ baseUrl: config.apiBaseUrl });
const build_lists = client.createDomainClient('/build-lists');

const { data, requestId } = await build_lists.get<BuildList[]>('/');
```

Exports `ApiClient`, `createApiClient`, `REQUEST_ID_HEADER`, the error types
`ApiError`, `ApiNetworkError` and `ApiTimeoutError`, the message formatter
`formatApiErrorMessage`, the WebbPulse error envelope reader
`getWebbPulseError` with its guard `isWebbPulseErrorBody`, the URL helpers
`joinUrl` and `serializeQuery`, and the opt in envelope layer `toEnvelope` and
`createEnvelopeClient`.

What it does, and why each piece is there:

- **Throws on a non 2xx.** `ApiError` carries `status`, the parsed `body`,
  `url`, `method` and the `requestId` the API echoed back. CarModPicker's axios
  instance already rejects; Portfolio's `request<T>` swallows everything and
  returns `{ data: null, error }`, which no call site is type forced to check.
  Both inventories recommend the rejecting contract, so this is it.
- **Credentials included by default.** The staging access gate sets CloudFront
  signed cookies, and a request without credentials does not carry them.
  Application auth is a bearer token and gate auth is a cookie, so a staging
  request sends both.
- **Retry with full jitter backoff, for idempotent methods only.** GET, HEAD
  and OPTIONS retry on a network failure, a timeout, and on 408, 425, 429 and
  5xx. A POST never retries.
- **Timeout and abort.** A caller signal composes with the timeout, and an
  abort raises `ApiTimeoutError` rather than a bare `AbortError`.
- **Request id passthrough.** Every request carries `x-request-id`, held
  constant across retries so all attempts for one logical call join up in the
  trace, and the response value is returned alongside the data. The backends
  generate a uuid7 per request today and are moving to OpenTelemetry trace ids;
  the header name is the one piece here the platform design leaves open, so it
  is a constant (`REQUEST_ID_HEADER`) rather than a literal.
- **Array query parameters repeat the key.** `ids=1&ids=2`, not `ids[]=1`.
  CarModPicker's `paramsSerializer` does this and the backend's `ids` and
  `category_ids` parameters depend on it.
- **Trailing slashes are preserved.** Portfolio's collection routes carry one
  and its item routes do not, and the distinction is load bearing against the
  backend's `TrailingSlashMiddleware`.
- **The shared error envelope is first class.** Every backend renders
  `{ success: false, status, message, request_id, error_code, details }` through
  `error_body` in the `webbpulse` Python package. `getWebbPulseError(error)`
  returns those fields flat and camel cased, with a message that is always
  renderable, so an application branches on `error_code` rather than on message
  text and neither consumer keeps its own reader.

`createDomainClient(prefix)` returns a client bound to a path prefix on the same
base URL, sharing the token source, retry policy and headers.

`toEnvelope(call)` and `createEnvelopeClient(client)` are the opt in `{ data,
error }` layer for an application whose call sites are not converted yet. The
throwing client stays the default and is untouched underneath; the envelope is
a migration step rather than a second supported contract. See the
[package README](packages/api-client#the--data-error--envelope).

### `@webbpulse/auth`

Two entry points. `@webbpulse/auth` is framework free; `@webbpulse/auth/react`
holds the React bindings, so an application importing only the core never pulls
React into its bundle.

```ts
import { SessionManager } from '@webbpulse/auth';
import { SessionProvider, useSession } from '@webbpulse/auth/react';

const session = new SessionManager<UserRead, LoginBody>({
  client,
  mode: 'token',
  tokenStorageKey: 'access_token',
  currentUserPath: '/users/me',
  loginPath: '/auth/token',
  encodeCredentials: (c) => new URLSearchParams({ ...c }),
});
```

Core exports `SessionManager`, `TokenStore`, `MemoryTokenStorage` and
`defaultTokenStorage`. React exports `SessionProvider`, `useSession`,
`useSessionState` and `useSessionManager`.

The generalisations that matter:

- **`status` is one field**, not separate `isAuthenticated` and `isLoading`
  booleans. Those two can express `{ isAuthenticated: true, isLoading: true }`,
  which means nothing. The distinct `'unknown'` state is what prevents the
  frame of signed out UI that Portfolio's `useState(false)` plus a mount effect
  renders today.
- **A 401 from the current user endpoint is `anonymous`, not an error.** Nobody
  being signed in is an expected answer. A 500 is an error and leaves any
  stored token alone, since it says nothing about the session.
- **The token key is a constructor argument.** CarModPicker stores
  `access_token` and Portfolio stores `authToken`. Neither is more correct, and
  a default would sign one application's users out on the deploy that adopted
  this package.
- **Concurrent refreshes de-duplicate**, so a burst of mounting components
  makes one request. This holds under React StrictMode double mounting.
- **`localStorage` failures degrade rather than throw.** Safari in private mode
  exposes a `localStorage` whose `setItem` throws, so the storage probe is a
  real write and the fallback is in memory.

### `@webbpulse/config`

```ts
import { loadAppConfig } from '@webbpulse/config';

export const config = loadAppConfig(import.meta.env, {
  defaultApiBaseUrl: '/api',
  defaultAppName: 'CarModPicker',
});
```

Exports `loadAppConfig`, `ConfigReader`, `ConfigError`, `ENVIRONMENT_NAMES` and
the `AppConfig`, `EnvironmentName`, `LoadAppConfigOptions` and `ViteEnv` types.

`backendTargets` maps a `VITE_BACKEND` value onto the base URL it selects, for
CarModPicker's `dev:staging` and `dev:prod` scripts. It is consulted only when
`DEV` is true, so a stray variable in a deploy environment cannot repoint a
shipped bundle. `apiPathPrefix` appends the path prefix the backends mount their
routers under, idempotently, so a base URL that already carries it is left
alone. Both default to absent and neither changes existing behaviour.

It takes the environment bag as an argument rather than reading
`import.meta.env` itself, which keeps it testable in Node and out of the way of
Vite's compile time string replacement. It reports every problem at once and
throws at startup, rather than failing later at the first request against an
`undefined` URL.

There is deliberately no built in default for the API base URL. Portfolio
hardcodes `http://localhost:8000/api/v1` in `services/api.ts` and
`http://localhost:8000` again in `vite.config.ts`, and that duplication is the
pattern this package exists to remove. An application that wants a local
default states it at the call site.

`ConfigReader` is exposed for keys beyond the common set, with `string`,
`optionalString`, `url`, `boolean` and `oneOf` readers that accumulate issues
until `assertValid()`.

### `@webbpulse/eslint-config`

Flat config. `baseConfig({ project, tsconfigRootDir })` gives type checked
TypeScript rules at CarModPicker's strictness, with the `no-unsafe-*` family and
`no-explicit-any` as errors and `eslint-config-prettier` last.
`reactConfig({ plugins })` layers React rules on top.

React plugins are peer dependencies passed in by the consumer rather than
dependencies of this package. The two applications are on different plugin sets
today, and forcing the union on both would make this config a blocker for
whichever one is slower to adopt.

The `eslint` peer range is `^9.0.0 || ^10.0.0`. CarModPicker is on ESLint 10 and
needed an `overrides` entry to install against the 0.2.0 range; it does not any
more. `@eslint/js` stays pinned to `^9.39.1` rather than widening with the peer,
because `@eslint/js@10` peer depends on `eslint@^10` and widening would
reintroduce the same conflict from the ESLint 9 side.

### `@webbpulse/tsconfig`

`base.json` (strict, plus `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes` and `noPropertyAccessFromIndexSignature`),
`library.json` (declarations and source maps), `vite-app.json` (DOM libs, JSX)
and `node.json`.

`node.json` sets no `types` array. Pinning `["node"]` there made the config
unusable for a consumer without `@types/node` installed, which is the common
case for the Vite config file it is applied to, and an unresolvable `types`
entry is a compile error. A project wanting the narrow set states it.

```json
{ "extends": "@webbpulse/tsconfig/vite-app.json" }
```

The two applications' `tsconfig.json` files are already byte identical, which
makes this and the ESLint config the cheapest adoptions in the set: no runtime
risk, and they can land before anything else here.

## Why there is no `@webbpulse/ui`

The brief allowed for a shared UI package only if both applications clearly
duplicate the same primitives. They do not.

CarModPicker has a full shadcn style system at `src/components/ui`: alert,
button, card, combobox, dialog, dropdown-menu, input, loading-overlay,
pagination, select, sheet, spinner, status-badge, tabs, textarea and toast, all
on Radix with CVA variants. Portfolio has four shared components, of which one
is a primitive: `Button`, plus `AnimatedOrb`, `GradientText` and
`GradientPanel`, which are marketing chrome with no CarModPicker use case.
Portfolio has no Input, Modal, Spinner or Toast component at all; its admin
forms hand write raw `<input className="...">` inline.

So the overlap is one component. Even that one does not match: CarModPicker's
`Button` spreads `ButtonHTMLAttributes`, supports `asChild` through a Radix Slot
and a `loading` state, and has variants `default | secondary | destructive |
outline | ghost | link` with sizes `sm | default | lg | icon`. Portfolio's takes
a closed prop set with no ref and no form attributes, and its variants are
`primary | secondary | outline | ghost` with sizes `sm | md | lg`.

The real blocker is underneath. CarModPicker is on Tailwind 4 with CSS first
configuration and semantic tokens (`bg-primary`, `border-input`, `ring-ring`).
Portfolio is on Tailwind 3.4 with a 250 line JavaScript config and literal
utilities (`bg-blue-600`, `dark:bg-gray-800`). A shared component emitting
`bg-primary` renders unstyled in Portfolio; one emitting `bg-blue-600` ignores
CarModPicker's token system. Migrating Portfolio to Tailwind 4 and a shared
token vocabulary is the prerequisite, and it is a larger job than the package.

Shipping a UI package now would mean one component neither application could
adopt unchanged. Revisit it after the Tailwind and token unification.

## Migration notes

### CarModPicker

The closest fit, since most of this was extracted from it.

- Replace `src/api/client.ts` with `createApiClient`. `getApiBaseUrl` moves to
  `loadAppConfig`; keep `/api` as the `defaultApiBaseUrl` so the Vite dev
  proxy keeps working. `normalizeApiUrl` becomes unnecessary once the base URL
  is validated at startup.
- Wire the client's `onTokenRefresh` to `SessionManager.setToken`. The
  `x-new-access-token` response header is read by the client already, and this
  is what keeps a username change from signing the user out.
- `src/contexts/AuthContext.tsx` and `useAuth` become `SessionProvider` and
  `useSession`. `AuthContextType.isLoading` maps to `isLoading`,
  `checkAuthStatus` to `refresh`, and `login(userData)` to `setUser` for flows
  that authenticate out of band, such as the OAuth and WebAuthn paths.
- The 401 branch in the axios interceptor is dead code today, with its redirect
  commented out. `onUnauthorized` is the deliberate replacement.
- `parseApiError` in `hooks/UseApiRequest.tsx` becomes
  `formatApiErrorMessage`. The roughly 91 call sites that inline their own
  `axiosError.response?.data?.detail || 'fallback'` can move to
  `error.message`, which is already that string.
- `src/utils/apiError.ts` can go. `getWebbPulseError` reads the same envelope
  off an `ApiError` and returns `error_code` and `details` alongside the
  message, which is what that local reader existed to do.
- The axios `paramsSerializer` can go: repeated array keys are the default.
- The 24 modules under `src/api/` become `createDomainClient` calls, one per
  path prefix.

### Portfolio

A larger change, because most of this does not exist there yet.

- `services/api.ts` returns `{ data, error }` and never throws. The shared
  client throws. Every call site, and `hooks/useApiData.ts` behind them, moves
  from checking `response.error` to a `try`/`catch`. This is the deliberate
  convergence rather than a compromise, and it should be one focused change.
- Failed responses currently discard the body, so FastAPI's `detail` never
  reaches the UI: a 401 renders as `HTTP error! status: 401`. Once `ApiError`
  carries the parsed body, `formatApiErrorMessage` surfaces the real text.
- Delete the hardcoded `http://localhost:8000/api/v1` and pass
  `VITE_API_BASE_URL` through `loadAppConfig`. Because the service builds
  absolute URLs today, the `/api` proxy in `vite.config.ts` is dead code and
  requests go straight to port 8000 on backend CORS. Decide which mechanism to
  keep: a relative base URL through the proxy is the simpler one, and matches
  CarModPicker.
- There is no auth context. `AdminPanel`'s local `useState(false)` plus a mount
  effect becomes `SessionProvider` and `useSession`, which also removes the
  signed out frame on first paint. Use `mode: 'token'` with
  `tokenStorageKey: 'authToken'` so existing sessions survive the deploy, and
  `loginPath: '/admin/login'` with the default JSON credential encoding.
- Portfolio has no current user endpoint. Until one exists, drive the session
  with `setUser` after login and pass `refreshOnMount={false}`, or add a
  `/admin/me` route and set `currentUserPath`.
- Adopt `@webbpulse/tsconfig` and `@webbpulse/eslint-config` first. They are
  independent of everything above, carry no runtime risk, and moving to type
  checked lint rules is what surfaces the rest.
- Note `arrowParens`: Portfolio sets `avoid`, this repository and CarModPicker
  use the default `always`. Align before sharing source, or the first format
  run churns every file.
