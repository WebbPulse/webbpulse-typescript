# webbpulse-typescript

Shared TypeScript packages for the WebbPulse applications, published to
CodeArtifact under the `@webbpulse` scope. CarModPicker and WebbPulse Portfolio
both consume them, and the point of this repository is one answer to each shared
problem rather than two.

## Contents

| Package                                              | What it is                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| [`@webbpulse/api-client`](packages/api-client)       | Typed fetch client. Framework free.                          |
| [`@webbpulse/auth`](packages/auth)                   | Identity client, with React bindings in a separate entry.    |
| [`@webbpulse/config`](packages/config)               | Validated accessors over `import.meta.env`.                  |
| [`@webbpulse/discovery`](packages/discovery)         | What a deployment of the identity service can do.            |
| [`@webbpulse/qrcode`](packages/qrcode)               | Dependency free byte mode QR encoder.                        |
| [`@webbpulse/eslint-config`](packages/eslint-config) | Shared flat ESLint configurations, and the Prettier options. |
| [`@webbpulse/tsconfig`](packages/tsconfig)           | Shared compiler configurations.                              |

Each package README is the reference for its own API. There is no
`@webbpulse/ui`: the two applications are on different Tailwind majors with
different token vocabularies, and their only overlapping primitive is a `Button`
whose prop sets do not match. Revisit after the Tailwind and token unification.

## What lives where

The frontend primitives both applications had written twice now live here, and
the applications import them rather than keeping local copies:

- **QR and TOTP provisioning encoding** is `@webbpulse/qrcode`. Both
  applications had a near-identical byte mode encoder next to their MFA
  enrolment panel.
- **Capability discovery**, the uncredentialed pre-auth probes that decide
  whether a sign-in page offers passkeys or a given OAuth provider, is
  `@webbpulse/discovery`, along with the `identityOriginFrom` and `identityUrl`
  pair every consumer of those gates needs. `Availability` is tri-state, since a
  read that could not be made is not the same as a deployment saying no.
- **The React session binding** is `@webbpulse/auth/react`. `AuthProvider` and
  `useAuth` own token lifetime, the silent refresh, StrictMode double-mount
  safety and the session-ended fan-out, so an application does not hand-roll a
  provider. `useOAuthCallback` handles the callback landing page.

Deliberately not shared: theme, tokens and the UI kits; the toast host; each
application's domain API surface; and the route guards, while the two
applications remain on different `react-router-dom` majors. Whether call sites
throw and catch `ApiError` or read `{ data, error }` through
`createEnvelopeClient` is a per-application choice, and `@webbpulse/api-client`
supports both.

## Installing from CodeArtifact

The packages are private. Point npm at the CodeArtifact repository first.

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

In CI the token comes from OIDC. There are no personal tokens anywhere. Domain
`webbpulse`, repository `npm`, region `us-west-2`, account `432410731887`.

## Toolchain

Node 22, npm workspaces, TypeScript 5.8 strict, tsup emitting ESM plus type
declarations, Vitest, ESLint 9 flat config, Prettier, changesets.

ESM only: both applications are Vite bundled and neither needs CommonJS. The
core packages depend on nothing beyond the standard library, and React is a peer
dependency of `@webbpulse/auth` that only the `/react` entry point touches.

## Local development

```bash
npm install
npm run build        # tsup across every workspace
npm run type-check
npm run lint
npm run format:check
npm run test:run
npm run test:run -- --coverage
```

`@webbpulse/auth` resolves `@webbpulse/api-client` through its built `dist`, so
run `npm run build` once after a fresh clone before type checking.

## Versioning

Changesets, with each package versioned independently, though in practice the
set moves in lockstep.

```bash
npm run changeset          # record what changed and how much it moves
npm run version-packages   # apply pending changesets, update changelogs
```

Publishing happens on a `v*` tag through
[`.github/workflows/publish.yml`](.github/workflows/publish.yml). CI requires a
changeset on any pull request touching `packages/`. See
[`.changeset/README.md`](.changeset/README.md) for the versioning rationale.

### Required repository configuration

Both workflows call the organisation's reusable workflows in `WebbPulse/.github`.

| Secret                          | Used by       | What it is                                                                                                                               |
| ------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `CODEARTIFACT_PUBLISH_ROLE_ARN` | `publish.yml` | IAM role in the Platform account, assumed via OIDC. Its trust policy admits only `repo:WebbPulse/webbpulse-typescript:ref:refs/tags/v*`. |
| `CODEARTIFACT_DOMAIN_OWNER`     | `publish.yml` | AWS account id owning the CodeArtifact domain: `432410731887`.                                                                           |

A GitHub Environment named `publish` gates the publish job; add required
reviewers there if a release should need approval. `ci.yml` needs no secrets:
this repository publishes the `@webbpulse` scope rather than consuming it.
