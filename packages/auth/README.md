# @webbpulse/auth

Framework free session helpers, with the React bindings in a separate entry so
an application importing only the core never pulls React into its bundle.

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

Wire the client's `onTokenRefresh` to `SessionManager.setToken` so a token the
API rotates in through the `x-new-access-token` response header is persisted.

## What it generalises

- **`status` is one field**, not separate `isAuthenticated` and `isLoading`
  booleans, which together can express states that mean nothing. The distinct
  `'unknown'` state is what prevents a frame of signed out UI on first paint.
- **A 401 from the current user endpoint is `anonymous`, not an error.** Nobody
  being signed in is an expected answer. A 500 is an error and leaves any
  stored token alone, since it says nothing about the session.
- **The token key is a constructor argument.** The two applications use
  different keys, and a default would sign one application's users out on the
  deploy that adopted this package.
- **Concurrent refreshes de-duplicate**, so a burst of mounting components
  makes one request. This holds under React StrictMode double mounting.
- **`localStorage` failures degrade rather than throw.** Safari in private mode
  exposes a `localStorage` whose `setItem` throws, so the probe is a real write
  and the fallback is in memory.

## Exports

Core: `SessionManager`, `TokenStore`, `MemoryTokenStorage`,
`defaultTokenStorage`.

`@webbpulse/auth/react`: `SessionProvider`, `useSession`, `useSessionState`,
`useSessionManager`. React is an optional peer dependency, needed only for this
entry point.
