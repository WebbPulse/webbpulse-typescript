---
'@webbpulse/auth': minor
---

`@webbpulse/auth/react` gains `useDismissedUntilSignIn(key)`, the state behind a
dismissible notice such as an "in development" banner that should greet every
new session. It returns `{ dismissed, dismiss }` and draws nothing. The flag lives
in `sessionStorage` under `DISMISSAL_STORAGE_PREFIX` plus the key, so it is per
tab, and it clears whenever the session settles signed out, so the next sign-in
shows the notice again; it never clears while the session is still unknown or
during a token refresh. Storage that throws falls back to memory for the page's
lifetime.
