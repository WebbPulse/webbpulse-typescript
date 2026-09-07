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

## Exports

`loadAppConfig`, `ConfigReader`, `ConfigError`, `ENVIRONMENT_NAMES` and the
`AppConfig`, `EnvironmentName` and `ViteEnv` types. `ConfigReader` is exposed
for keys beyond the common set, with `string`, `optionalString`, `url`,
`boolean` and `oneOf` readers that accumulate issues until `assertValid()`.
