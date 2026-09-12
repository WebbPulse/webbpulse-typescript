# Frontend Hoisting Plan: `@webbpulse/*` Next Steps

## 1. What `@webbpulse/*` already provides

Publisher: `/home/tyler-webb/Documents/Github/WebbPulse/webbpulse-typescript` (npm workspaces + changesets, `packages/*`). CodeArtifact query succeeded with profile `WebbPulse-Artifacts/ReadOnlyAccess`; registry and repo agree.

| Package                    | Version (CodeArtifact + repo) | Published versions | Entry points                                              | Notable exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------- | ----------------------------- | ------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@webbpulse/api-client`    | 0.8.0                         | 0.1.0 - 0.8.0      | `.`                                                       | `ApiClient`, `createApiClient`, `createEnvelopeClient`, `toEnvelope`, `ApiError`, `ApiNetworkError`, `ApiTimeoutError`, `getWebbPulseError`, `isWebbPulseErrorBody`, `formatApiErrorMessage`, `parseRetryAfter`, `retryAfterFromHeaders`, `joinUrl`, `serializeQuery`, `REQUEST_ID_HEADER`                                                                                                                                                                                                                                                                                                                                                                                          |
| `@webbpulse/auth`          | 0.8.0                         | 0.1.0 - 0.8.0      | `.`, `./react`                                            | `AuthClient`/`createAuthClient`, `SessionManager`, email flows (`readLinkToken`, `LINK_TOKEN_PARAM`, `RESET_PASSWORD_PATH`, `VERIFY_EMAIL_PATH`, `classifyLinkError`), MFA (`TOTP_FACTOR`, `classifyMfaError`), OAuth (`GOOGLE_PROVIDER`, `GITHUB_PROVIDER`, `readOAuthCallback`, `stripOAuthParams`, `parseOAuthLinks`, `classifyOAuthError`), passkeys (`passkeysSupported`, `conditionalMediationAvailable`, `toCreationOptions`, `toRequestOptions`, `classifyPasskeyError`, base64url helpers), errors (`AUTH_ERROR_CODES`, `describeAuthError`, `getAuthErrorCode`). React entry: `AuthProvider`, `useAuth`, `useAuthClient`, `useAuthState`, `SessionProvider`, `useSession` |
| `@webbpulse/config`        | 0.8.0                         | 0.1.0 - 0.8.0      | `.`                                                       | `ConfigReader`, `ConfigError`, `loadAppConfig`, `ENVIRONMENT_NAMES`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `@webbpulse/tsconfig`      | 0.8.0                         | 0.1.0 - 0.8.0      | `base.json`, `library.json`, `vite-app.json`, `node.json` | compiler presets                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `@webbpulse/eslint-config` | 0.8.0                         | 0.1.0 - 0.8.0      | `.`, `./base`, `./react`                                  | `baseConfig()`, `reactConfig()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Total package source: ~12.5k lines across `packages/*/src`.

### Who consumes what

| Package         | CMP `frontend/`                                                                                                                            | Portfolio `frontend/`                                              | CMP `chrome-extension/`    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------- |
| `api-client`    | Yes (8 files; `api/client.ts`, `utils/apiError.ts`, tests)                                                                                 | Yes (`services/api.ts`, envelope client)                           | **No**                     |
| `auth`          | Yes (10 files; `identityClient.ts`, `identityAuth.ts`, `identityOAuth.ts`, `identityPasskeys.ts`, `oauthProviders.ts`, route + page files) | Yes (11 files; `services/api.ts`, `hooks/*`, `components/admin/*`) | **No**                     |
| `auth/react`    | **No** (hand-rolled `AuthContext`)                                                                                                         | **No** (hand-rolled provider in `AdminPanel`)                      | **No**                     |
| `config`        | Yes (`config/app.ts`)                                                                                                                      | Yes (`services/api.ts`)                                            | **No**                     |
| `tsconfig`      | Yes (`tsconfig.app.json`, `tsconfig.node.json`)                                                                                            | Yes (both)                                                         | **No** (hand-copied clone) |
| `eslint-config` | Yes (`eslint.config.js`)                                                                                                                   | Yes (`eslint.config.js`)                                           | **No** (no ESLint at all)  |

The chrome extension consumes **zero** `@webbpulse/*` packages. Both frontends are on 0.8.0 and neither uses the `auth/react` entry point that already exists.

## 2. Duplicated and near-duplicated code

### A. QR / TOTP provisioning encoder (near-verbatim clone)

| Side      | File                           | Lines |
| --------- | ------------------------------ | ----- |
| CMP       | `frontend/src/utils/qrCode.ts` | 583   |
| Portfolio | `frontend/src/utils/qrCode.ts` | 598   |

Similarity: **~95 percent**. Identical exported surface (`QrMatrix`, `encodeQrCode`, `qrCodeSvgPath`), identical algorithm, identical ISO/IEC 18004 tables, identical byte-mode / level-M / versions 1-10 / four-penalty-rule mask selection. `diff` is 151 lines and is entirely docstring rewording plus one Prettier `arrowParens` difference (`(block) =>` vs `block =>`). Each side also carries its own `qrCode.test.ts`. Consumers: CMP `components/profile/IdentityTotpSettings.tsx`, Portfolio `components/admin/SecuritySection.tsx`.

### B. Capability discovery gates (same design, divergent types)

| Concern                  | CMP                              | Lines | Portfolio                             | Lines | Similarity                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------ | -------------------------------- | ----- | ------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Promise-coalescing cache | `src/api/availabilityCache.ts`   | 41    | `src/services/availabilityCache.ts`   | 49    | ~90 percent. Same `Availability` tri-state union, same `Map<string, Promise<Availability>>` keyed by full URL, same evict-on-`unknown`. Only the parameter name differs (`read` vs `probe`).                                                                                                                                                                                                                                                                                                                                                       |
| Passkey availability     | `src/api/passkeyAvailability.ts` | 125   | `src/services/passkeyAvailability.ts` | 117   | ~75 percent. Same route constant `/api/auth/passkeys/availability`, same uncredentialed GET with `credentials: 'omit'` + `accept: application/json`, same status-200-only gate, same side map beside the cache. **Differs:** CMP returns tri-state `{enabled, passwordless}` as `Availability`; Portfolio returns booleans with `{enabled:false,passwordless:false}` as the unknown sentinel. Reset helpers differ in name.                                                                                                                        |
| OAuth provider discovery | `src/api/oauthProviders.ts`      | 115   | `src/services/oauthAvailability.ts`   | 142   | ~80 percent. Same route constant `/api/auth/oauth/providers`, same uncredentialed GET, identical `providerLabel()` switch (Google / GitHub / title-case fallback), same cache-beside-map pattern. **Differs:** CMP field is camelCase `displayName` with a `providerLabel` fallback for a missing name and drops entries keyed only on `id`; Portfolio keeps the wire shape `display_name` and requires both fields non-empty. CMP imports the provider constants from `@webbpulse/auth`; Portfolio hardcodes the strings `'google'` / `'github'`. |

Subtotal for this cluster: **281 CMP lines vs 308 Portfolio lines**, both with separate tests.

### C. Identity client construction and origin derivation

| Side      | File                                                                                   | Lines                    |
| --------- | -------------------------------------------------------------------------------------- | ------------------------ |
| CMP       | `frontend/src/api/identityClient.ts`                                                   | 87                       |
| Portfolio | inside `frontend/src/services/api.ts` (`identityOriginFrom`, `ApiService` constructor) | ~731 total, ~80 relevant |

Similarity: ~70 percent on the shared concern. `identityOriginFrom()` is the same function in both (parse `new URL(base).origin`, fall back to the raw base), diverging only in the relative-path branch: CMP returns `''` for a leading-slash base, Portfolio returns the base unmodified. Both construct `createAuthClient({ baseUrl: origin, clientOptions: { credentials: 'include' } })`. CMP adds a lazy-build singleton plus a `WebAuthnAdapter` test seam; Portfolio builds eagerly in a class constructor and wires `onSessionEnded`.

### D. Passkey and OAuth presentation hooks

| Concern                           | CMP                                                                                               | Lines | Portfolio                                                           | Lines   | Similarity                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Should I offer a passkey button" | `components/authentication/PasskeySignInButton.tsx` (availability + conditional mediation inline) | 112   | `hooks/usePasskeySignIn.ts`                                         | 69      | ~65 percent on logic. Both gate on `passkeysSupported()`, then the deployment's `passwordless` flag, then `conditionalMediationAvailable()`, with a `live`/abort guard. CMP fuses this with the button render and arms a conditional ceremony via `AbortController`; Portfolio returns `{offered, conditional}` and leaves rendering to `LoginForm`. |
| OAuth provider list for buttons   | `components/authentication/OAuthProviderButtons.tsx`                                              | 72    | `hooks/useOAuthProviders.ts` + `components/admin/OAuthButtons.tsx`  | 45 + 75 | ~60 percent. Same effect shape and `live` guard, same empty-list-renders-nothing rule.                                                                                                                                                                                                                                                               |
| OAuth callback consumption        | `hooks/useOAuthCallback.ts` (ref-guarded, `history.replaceState` to strip single-use params)      | 40    | handled in `components/admin/AdminPanel.tsx` / `OAuthCallback` test | n/a     | ~50 percent. CMP's is the cleaner extraction; Portfolio's is inlined.                                                                                                                                                                                                                                                                                |

### E. Session / auth React binding (both reinvent `@webbpulse/auth/react`)

| Side      | File                                                                         | Lines                              |
| --------- | ---------------------------------------------------------------------------- | ---------------------------------- |
| CMP       | `contexts/AuthContext.tsx` + `AuthContextDefinition.ts` + `hooks/useAuth.ts` | 105 + 22 + 15                      |
| Portfolio | session wiring inside `components/admin/AdminPanel.tsx`                      | 1450 total, session slice embedded |

Similarity: ~55 percent in intent, low in structure. Both hold `{user, isAuthenticated, isLoading, login, logout, refresh}` and bootstrap by spending the refresh cookie on mount. CMP uses `useState` + `useCallback` and a `restoreSession()` call; Portfolio goes through `ApiService.restoreSession()` and `onSessionEnded`. **The package already exports `AuthProvider` / `useAuth` / `useAuthState` built on `useSyncExternalStore`, which is strictly better than both** (no tearing under concurrent rendering, bound stable methods, StrictMode-safe shared in-flight `initialize`).

### F. Error envelope to message

| Side      | File                                                                                | Lines |
| --------- | ----------------------------------------------------------------------------------- | ----- |
| CMP       | `utils/apiError.ts` (`getApiErrorMessage`, `getApiErrorCode`, `getApiErrorDetails`) | 45    |
| Portfolio | `logApiFailure` + `readLoginFailure` inside `services/api.ts`                       | ~35   |
| Extension | inline `detail` parsing inside `apiRequest` in `background.ts`                      | ~30   |

Similarity: ~60 percent between the two frontends (both narrow to `ApiError` then call `getWebbPulseError`); the extension is a **third, incompatible** shape that parses FastAPI's old `{detail}` form and knows nothing about the `webbpulse` envelope. This matches the known error-envelope divergence.

### G. Extension HTTP + token layer (no shared code at all)

`chrome-extension/src/background.ts` is 981 lines and hand-rolls everything the packages provide: `apiRequest<T>` with manual `Authorization: Bearer` and `X-API-Key` headers, tokens in `chrome.storage.local`, two parallel nonce-bound handoff flows (`pendingWebAuth` legacy JWT post, `pendingIdentityAuth` code exchange against `/auth/extension/token`), a host allowlist (`isAllowedWebHost`, suffix `carmodpicker.com` plus exact `localhost`/`127.0.0.1`), `generateNonce`, 10-minute TTLs, and a manual 401 path that calls `removeToken()`. **There is no refresh handling**: the handoff comment states no refresh token comes back, so an expired access token means signing in again. `LoginScreen.tsx` polls `getCurrentUser` every 1500 ms as a substitute for a session subscription.

### H. Form validation helpers

Portfolio has `utils/validation.ts` (74 lines: `validateEmail`, `validateRequired`, `validateMinLength`, `validateMaxLength`, `validateUrl`, `getValidationError`). CMP has **no equivalent** and neither does the extension. Not duplication today; it is a one-sided primitive.

### I. Theme and tokens

CMP `src/styles/tokens.css` is 374 lines of Tailwind v4 design tokens with a Radix + `class-variance-authority` + `tailwind-merge` UI kit under `components/ui/` (24 files). Portfolio `src/styles/globals.css` is 97 lines on Tailwind v3 with `components/common/` (Button, GradientPanel, GradientText, AnimatedOrb). Similarity: **very low**. Different Tailwind majors, different visual languages, different component inventories.

## 3. Ranked candidates

Scoring inputs: churn is commits touching the path on `origin/staging` in the last 60 days. Repo totals for context: CarModPicker 265 commits, Portfolio 279, webbpulse-typescript 13.

| Candidate                                                  | Security relevance                                                                        | Dup size (lines) | Churn (CMP / PF) | Coupling risk                                                 | Score            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ---------------- | ---------------- | ------------------------------------------------------------- | ---------------- |
| Capability discovery gates (B)                             | High: uncredentialed pre-auth probes, gate whether passwordless sign-in is offered        | 281 / 308        | 3+3+2 / 4+4+5    | Low: pure functions over `fetch`, injectable `fetchImpl`      | **1**            |
| React session binding (E) migrate to existing `auth/react` | High: token lifetime, refresh-on-mount, session-ended handling                            | 142 / embedded   | 6 / 11 (admin)   | Medium: touches provider tree and every guard                 | **2**            |
| QR/TOTP encoder (A)                                        | Medium: renders the TOTP secret; a wrong matrix silently locks users out of MFA enrolment | 583 / 598        | 2 / 2            | Very low: one pure function, two call sites                   | **3**            |
| Error envelope normalisation (F)                           | Medium: user-facing message selection, leak surface                                       | 45 / 35 / 30     | 4 / 11 (api.ts)  | Low                                                           | 4                |
| Passkey/OAuth presentation hooks (D)                       | Medium-high                                                                               | 224 / 189        | 6+9 / 6+11       | Medium: React-coupled, CMP fuses logic into a button          | 5                |
| Extension onto `api-client` + `auth` (G)                   | **Highest** (see note)                                                                    | 981              | 5                | **High**: MV3 service worker, `chrome.storage`, no cookie jar | 6                |
| Shared tsconfig for the extension (config drift)           | Low                                                                                       | ~45              | 1                | Low, but blocked on TS 7                                      | 7                |
| Form validation (H)                                        | Low                                                                                       | 74 one-sided     | 1                | Very low                                                      | 8                |
| Theme/tokens (I)                                           | None                                                                                      | n/a              | 0 / n/a          | Very high                                                     | **Do not hoist** |

### Recommended top 3

#### 1. New package: `@webbpulse/discovery` (0.9.0)

Hoists cluster B, and the `identityOriginFrom` / `identityUrl` pair from cluster C, which every consumer of the gates needs anyway.

Proposed public API:

```
// index.ts
export type Availability = 'available' | 'unavailable' | 'unknown';
export function cachedAvailability(key, probe): Promise<Availability>;
export function resetAvailabilityCache(): void;

export function identityOriginFrom(apiBaseUrl: string, opts?: { relativeAs?: 'empty' | 'passthrough' }): string;
export function identityUrl(origin: string, path: string): string;

export const PASSKEY_AVAILABILITY_PATH: '/api/auth/passkeys/availability';
export interface PasskeyCapabilities { enabled: Availability; passwordless: Availability }
export function parsePasskeyCapabilities(body: unknown): PasskeyCapabilities;
export function passkeyCapabilities(url, fetchImpl?): Promise<PasskeyCapabilities>;
export function passkeyLoginAvailability(url, fetchImpl?): Promise<Availability>;
export function passkeyEnrolmentAvailability(url, fetchImpl?): Promise<Availability>;

export const OAUTH_PROVIDERS_PATH: '/api/auth/oauth/providers';
export interface OAuthProviderInfo { id: string; displayName: string }
export function providerLabel(provider: string): string;
export function parseProviders(body: unknown): OAuthProviderInfo[];
export function oauthProviders(url, fetchImpl?): Promise<OAuthProviderInfo[]>;
```

Resolve the two divergences in the package, not per consumer: keep CMP's **tri-state** `Availability` (it is the safer model, since `unknown` is not `unavailable`) and CMP's **camelCase `displayName`** normalisation, and take `providerLabel`'s Google/GitHub constants from `@webbpulse/auth` so they cannot drift. Depend on `@webbpulse/auth` for the provider constants, or accept them as options to keep the dependency direction clean.

Migration:

- CMP: delete `src/api/availabilityCache.ts`, `src/api/passkeyAvailability.ts`, `src/api/oauthProviders.ts` and their tests; re-export from `src/api/identityClient.ts` so the 5 call sites (`PasskeySignInButton`, `OAuthProviderButtons`, `IdentityConnectedAccounts`, `IdentityPasskeySettings`, `LoginIdentity` test) are unchanged.
- Portfolio: delete `src/services/availabilityCache.ts`, `src/services/passkeyAvailability.ts`, `src/services/oauthAvailability.ts` and tests. Two call-site edits are required: `hooks/usePasskeySignIn.ts` moves from `passkeyLoginOffered(origin) => boolean` to `passkeyLoginAvailability(url) === 'available'`, and `hooks/useOAuthProviders.ts` / `components/admin/OAuthButtons.tsx` move from `display_name` to `displayName`. Portfolio's gates take an **origin** and build the URL internally while CMP's take a **full URL**, so pick the full-URL form (CMP's) and have Portfolio's hooks call `identityUrl()`.
- Portfolio's `identityOriginFrom` needs `relativeAs: 'passthrough'` to preserve today's behaviour.

#### 2. Adopt the existing `@webbpulse/auth/react` entry point (no new package)

Zero publishing work; the surface already exists and is better than either hand-rolled version. This is the highest security-value move because it puts token lifetime, silent refresh, StrictMode double-mount safety and session-ended fan-out behind one tested implementation.

Migration:

- CMP: replace `contexts/AuthContext.tsx`, `contexts/AuthContextDefinition.ts` and `hooks/useAuth.ts` with `AuthProvider` + `useAuth` from `@webbpulse/auth/react`, passing the `getIdentityClient()` instance. Keep a thin local `useAuth` wrapper that adds the CMP-specific pieces the package does not own: the `Sentry.setUser` effect, the `UserRead` typing, and the `navigate('/')` on logout. `components/routes/ProtectedRoute.tsx`, `GuestRoute.tsx` and `EmailVerifiedRoute.tsx` then need no change because they only read `{isAuthenticated, isLoading}`.
- Portfolio: lift the session slice out of `AdminPanel.tsx` (1450 lines) onto `AuthProvider`, driving it from `ApiService.getAuthClient()`. `onSessionEnded` maps onto the package's state subscription.
- Also hoist CMP's `hooks/useOAuthCallback.ts` (40 lines) into the package's React entry as `useOAuthCallback`; it is the correct ref-guarded + `replaceState` implementation and Portfolio currently inlines a weaker equivalent.

#### 3. New package: `@webbpulse/qrcode` (or a `./qrcode` subpath on a small `@webbpulse/ui-utils`)

Proposed public API: `encodeQrCode(text): QrMatrix`, `qrCodeSvgPath(text): { path, size }`, `type QrMatrix`. Framework-free, zero dependencies, one test suite instead of two.

Migration: delete both `src/utils/qrCode.ts` and both `qrCode.test.ts`; update the single import in CMP `components/profile/IdentityTotpSettings.tsx` and Portfolio `components/admin/SecuritySection.tsx`. This is the lowest-risk item on the list (1181 duplicated lines removed, 2 call sites, zero behavioural choices to make) and is a good first PR to prove the release train.

### Where the apps legitimately differ: do NOT unify

- **Theme, tokens and UI kit.** CMP is Tailwind v4 + Radix + CVA + `tailwind-merge` with a 374-line token file and a 24-file `ui/` kit; Portfolio is Tailwind v3 with gradient/orb marketing components. Different Tailwind majors alone make a shared kit a blocker, and the two products have deliberately different visual languages.
- **Toast and notification host.** CMP uses `sonner` with app-specific Tailwind class mappings (`components/ui/toast.tsx`, 30 lines). Portfolio has no toast host. Nothing to share.
- **Auth mode configuration.** CMP's `api/authMode.ts` is a post-cutover constant (`AUTH_MODES = ['identity']`, `AUTH_MODE = 'identity'`); Portfolio's `services/authMode.ts` still carries `['bearer','identity']` and the `VITE_AUTH_MODE` reader. These converge when Portfolio finishes its cutover; hoisting now would freeze a migration artifact.
- **`BearerTokenStore`** (Portfolio, 57 lines) is explicitly scheduled for deletion at the identity cutover. Do not hoist a doomed primitive.
- **Domain API surfaces.** CMP's `api/*.ts` per-resource modules and Portfolio's `ApiService` DTOs (`Project`, `BlogPost`, `SiteContent`, ...) are product data and belong to their apps.
- **Router version.** CMP is on `react-router-dom` ^7.15.0, Portfolio on ^6.30.1. Any hoisted route guard would have to peer-depend across a major; keep guards local until the versions converge.
- **Envelope style.** CMP call sites throw and catch `ApiError`; Portfolio call sites read `{data, error}` via `createEnvelopeClient`. Both are already supported by `api-client`. This is a legitimate per-app choice, not drift to fix.

## 4. Config drift

### Versions

| Tool              | CMP `frontend/`                | Portfolio `frontend/`                                                                                  | CMP `chrome-extension/`        | webbpulse-typescript |
| ----------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------ | ------------------------------ | -------------------- |
| typescript        | ~5.8.3                         | ~5.8.3                                                                                                 | **~7.0.2**                     | ~5.8.3               |
| typescript-eslint | ^8.69.0                        | ^8.35.1                                                                                                | not installed                  | ^8.46.0              |
| eslint            | **^10.10.0**                   | ^9.30.1                                                                                                | not installed                  | ^9.39.1              |
| `@eslint/js`      | **^10.0.1**                    | ^9.30.1                                                                                                | not installed                  | ^9.39.1              |
| prettier          | ^3.9.6                         | ^3.9.6                                                                                                 | **not installed**              | ^3.6.2               |
| vite              | ^8.2.2                         | ^8.2.2                                                                                                 | ^8.2.2                         | n/a                  |
| vitest            | ^5.0.0                         | ^5.0.0                                                                                                 | ^5.0.0                         | **^3.2.4**           |
| react             | ^19.2.8                        | ^19.2.8                                                                                                | ^19.2.8                        | ^19.2.0 (dev)        |
| react plugin      | `plugin-react-swc` ^4.3.3      | both `plugin-react` ^6.1.1 and `plugin-react-swc` ^4.3.3 installed; vite uses swc, vitest uses non-swc | `plugin-react-swc` ^4.3.3      | swc                  |
| tailwind          | ^4.1.7 (+ `@tailwindcss/vite`) | **^3.4.17** (+ postcss/autoprefixer)                                                                   | ^4.3.3 via `@tailwindcss/vite` | n/a                  |
| node in CI        | 22                             | **20**                                                                                                 | 22                             | engines >=22         |
| `@webbpulse/*`    | 0.8.0                          | 0.8.0                                                                                                  | **none**                       | source               |

### Settings drift

- **Prettier**: CMP `.prettierrc.json` has 6 keys; Portfolio `.prettierrc` has 10 and adds **`arrowParens: "avoid"`** and `endOfLine: "lf"`. That single `arrowParens` difference is what makes the otherwise-identical `qrCode.ts` files textually diverge, and it will make every future hoist look like a real diff. There is no shared `@webbpulse/prettier-config` package. Also, CMP formats a narrow glob (`"src/**/*.{ts,tsx,json,css}"` plus root files) while Portfolio formats `.` wholesale. The extension has **no Prettier and no ESLint config at all**.
- **ESLint**: both consume `@webbpulse/eslint-config/react`, but wire it differently. CMP passes 4 plugins (`react-hooks`, `react-refresh`, `react-x`, `react-dom`), spreads `reactX.configs['recommended-typescript'].rules`, disables three `react-x` rules, and adds a `no-restricted-imports` guard against retired `components/common/*`. Portfolio passes 2 plugins and layers `eslint-plugin-prettier` with `'prettier/prettier': 'error'` on top, which CMP does not do. CMP lints only `./tsconfig.app.json`; Portfolio lints both `tsconfig.app.json` and `tsconfig.node.json`. CMP ignores `e2e/`.
- **tsconfig**: both frontends correctly extend `@webbpulse/tsconfig/vite-app.json` and `/node.json` and add only `incremental` + `tsBuildInfoFile` (the shared base deliberately leaves the buildinfo path to the consumer). The **extension does not extend anything** - `chrome-extension/tsconfig.json` is a hand-copied clone of `base.json` + `vite-app.json` (same `strict`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `moduleDetection: force`) that diverges on `target`/`lib` (**ES2020** vs ES2022), is missing `allowSyntheticDefaultImports`, `useDefineForClassFields` is present but `noFallthroughCasesInSwitch` sits in a different block, and it adds `"types": ["chrome"]` plus a `paths` alias `@/*`.
- **Vitest**: CMP sets `css: true`, explicit `include`/`exclude`, and hard coverage thresholds (lines 51, functions 41, branches 38, statements 49). Portfolio sets no thresholds and a different exclude list. Setup file names differ (`src/test/setup.ts` vs `src/test-setup.ts`). The publisher repo is still on vitest 3 while both consumers are on 5.
- **Vite**: CMP adds `@sentry/vite-plugin` (CI-only, gated on `CI` + `SENTRY_AUTH_TOKEN`), `sourcemap: 'hidden'`, a `preview.allowedHosts` list, and dev port 4000; Portfolio uses port 5173 and a mode-gated proxy. Both proxy `/api` to `localhost:8000` but spell the option **`changeOrigin`** (Vite's real option is `changeOrigin` on the `http-proxy` passthrough, so this is consistent between them, just worth noting as copied).
- **CI**: both use `WebbPulse/.github/.github/workflows/typescript-ci.yml@v2` and `python-ci.yml@v2` with a `changes` paths-filter job and an `all-checks-passed` gate, so the org-level hoist is already done for the frontends. Drift: different `dorny/paths-filter` pins (CMP v3.0.2 `de90cc6f`, Portfolio v4.0.3 `ceb8a2b8`), different node (22 vs 20), CMP checkout lacks `persist-credentials: false`, and CMP has two extra bespoke jobs (`frontend-audit-and-imports` running `npm audit` + `madge --circular`, and a 100-percent-hand-rolled `chrome-extension` job). **The extension job does not use the shared reusable workflow** - it hand-rolls setup-node, `npm ci`, type-check, test, audit, build, manifest check and `check-host-permissions.js`.

### TS 7 blocker (confirmed)

Two independent halves:

1. **`typescript-eslint` peer range.** Installed `typescript-eslint@8.69.0` declares `peerDependencies: { typescript: ">=4.8.4 <6.1.0" }`. `@webbpulse/eslint-config@0.8.0` depends on `typescript-eslint: ^8.46.0`, so the shared config cannot be consumed by any project on TypeScript 7. The extension is **already on `typescript: ~7.0.2`**, which is exactly why it is the one workspace with no ESLint and no `@webbpulse/tsconfig` - it cannot adopt either today. The two frontends are pinned at `~5.8.3` and are unaffected until they move. Unblocking needs a `typescript-eslint` release whose peer range admits 7.x, then a major bump of `@webbpulse/eslint-config` (its own `eslint` peer `^9 || ^10` is already fine, and CMP is on eslint 10 while Portfolio is on 9, so that axis is covered).

2. **`types` field in the shared tsconfig.** `@webbpulse/tsconfig` currently declares **no `types` field in any preset** - it was deliberately removed from `node.json` (tsconfig CHANGELOG: "`@webbpulse/tsconfig/node.json` no longer pins `"types": ["node"]`... A project that wants the narrow set now states it, and narrowing only ever removes globals so it is the safe direction to leave to the consumer"). With no `types` pin, TypeScript auto-includes every `@types/*` package it finds, which is the behaviour TS 7 tightens. For the extension to extend a shared preset it must contribute `"types": ["chrome"]`, and narrowing from "everything" to "chrome only" would drop the `node`/`vite/client` globals the Vite config and `vite-env.d.ts` rely on. The fix is an additive one in the shared package - either a new `browser-extension.json` preset that sets `"types": ["chrome"]` explicitly, or re-introducing an explicit `types` array in `vite-app.json` (for example `["vite/client"]`) that a consumer extends rather than silently inherits - and it must land in the same major as the `typescript-eslint` bump so the extension can adopt both in one PR.

Practical consequence for this plan: recommendations 1, 2 and 3 all target the two frontends on TS 5.8 and are **not blocked**. Extension adoption (candidate 6 and the tsconfig item) is gated on the TS 7 work and should be sequenced after it.
