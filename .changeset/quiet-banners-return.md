---
'@webbpulse/auth': minor
---

`@webbpulse/auth/react` gains `useDismissedUntilSignIn(key)`, the state behind a
dismissible notice such as an "in development" banner that should greet every
new session. It returns `{ dismissed, dismiss }` and draws nothing. The flag lives
in `sessionStorage` under `DISMISSAL_STORAGE_PREFIX` plus the key, so it is per
tab. It records whether it was made signed in or signed out and lapses when the
session settles on the other side: a dismissal made in a session lapses on the
sign-out or expiry that ends it, so the next sign-in shows the notice again, and
one made while signed out survives reloads and lapses on the next sign-in.
Nothing lapses while the session is unknown or during a token refresh. Storage
that throws falls back to memory for the page's lifetime.
