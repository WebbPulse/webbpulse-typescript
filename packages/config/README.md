# @webbpulse/config

Validated runtime configuration for the WebbPulse Vite applications.

```ts
import { loadAppConfig } from '@webbpulse/config';

export const config = loadAppConfig(import.meta.env, {
  defaultApiBaseUrl: '/api',
  defaultAppName: 'CarModPicker',
});
```

It takes the environment bag as an argument rather than reading
`import.meta.env` itself, which keeps it testable in Node and out of the way of
Vite's compile time string replacement.

It reports **every** problem at once and throws `ConfigError` at startup, rather
than failing later at the first request against an `undefined` URL.

```
Invalid application configuration:
  - VITE_ENVIRONMENT must be one of local, staging, production, got "nope"
  - VITE_API_BASE_URL must use http or https, got "ftp:"
```

`VITE_API_BASE_URL` accepts an absolute `http`/`https` URL or a root relative
path such as `/api`. A bare host is rejected: an implicit protocol is the kind
of guess that fails in one environment only.

There is deliberately no built in default for the API base URL. An application
that wants a local default states it at the call site, where it is visible.

## The dev backend switch and the path prefix

Two options cover the URL shaping an application would otherwise have to do
before calling `loadAppConfig`, which is exactly the place a hardcoded URL
survives unvalidated.

```ts
export const config = loadAppConfig(import.meta.env, {
  defaultApiBaseUrl: '/api',
  defaultAppName: 'CarModPicker',
  backendTargets: {
    staging: import.meta.env.VITE_STAGING_API_URL,
    production: import.meta.env.VITE_PROD_API_URL,
  },
  apiPathPrefix: '/api',
});
```

### `backendTargets`

A map from the value of `VITE_BACKEND` to the base URL that value selects.
CarModPicker's `npm run dev:staging` and `npm run dev:prod` set that variable so
a local dev server talks to a deployed backend instead of localhost.

- **Consulted only when `DEV` is true.** A production bundle reads
  `VITE_API_BASE_URL` as it always did, so a stray `VITE_BACKEND` in a deploy
  environment cannot repoint a shipped build at another backend. The switch is a
  developer convenience, and a convenience that survives into production is a
  way to ship the wrong URL.
- **A matched target wins over `VITE_API_BASE_URL`.** A developer who ran
  `dev:staging` meant it.
- **An unset switch, an unmapped value, and a mapped `undefined` all fall
  through** to the normal resolution. That last one is what lets a caller pass
  `import.meta.env.VITE_STAGING_API_URL` straight in without guarding it first.
- **Matching is case insensitive**, and the selected URL is validated through
  the same reader as `VITE_API_BASE_URL`. A malformed entry throws at startup
  naming the key that supplied it (`VITE_BACKEND=staging`) rather than the
  variable that merely selected it.

`backendTargetKey` renames the switch variable if an application does not spell
it `VITE_BACKEND`.

### `apiPathPrefix`

A path suffix appended to the resolved base URL, for the backends that mount
every router under one prefix.

The deploy writes a bare origin into the environment because that is what the
Terraform `api_url` output is, so somebody has to join the two. Doing it here
means the joined value is what gets validated, rather than the half of it that
was in the environment.

Appending is **idempotent**: a base URL whose path already ends with the prefix
is left alone, so `https://api.example.com/api` does not become
`https://api.example.com/api/api`. That matters because the two applications
disagree today about whether the variable holds the origin or the full base, and
both spellings are in deploy configuration right now.

Both options default to absent, and a call that passes neither behaves exactly
as it did in 0.2.0.

## Exports

`loadAppConfig`, `ConfigReader`, `ConfigError`, `ENVIRONMENT_NAMES` and the
`AppConfig`, `EnvironmentName`, `LoadAppConfigOptions` and `ViteEnv` types. `ConfigReader` is exposed
for keys beyond the common set, with `string`, `optionalString`, `url`,
`boolean` and `oneOf` readers that accumulate issues until `assertValid()`.
