---
'@webbpulse/auth': minor
---

Add `useQueryAuth` to `@webbpulse/auth/react`, the `auth` option for
`usePolledQuery` bound to the client already in context, so an application does
not hand-roll the adapter and cannot ship a query that boots anonymous.
