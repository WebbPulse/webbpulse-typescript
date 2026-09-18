---
'@webbpulse/api-client': minor
'@webbpulse/auth': minor
'@webbpulse/config': minor
'@webbpulse/discovery': minor
'@webbpulse/qrcode': minor
'@webbpulse/eslint-config': minor
'@webbpulse/tsconfig': minor
---

Added `usePolledQuery` and `useMutationWithRefetch` in the new
`@webbpulse/api-client/react` entry point. `usePolledQuery` polls a fetcher on
an interval with refetch on window focus and on return to visibility, pausing
while the document is hidden, exponential backoff with jitter up to a cap that
resets on success, an `enabled` flag, manual `refetch`, `isStale` and
`lastUpdatedAt`, request de-duplication and abort of the in-flight request on
unmount. It honours `waitForToken` so a query mounted during boot waits for the
first refresh instead of going out anonymous. `useMutationWithRefetch`, with the
`invalidateQueries` and `subscribeToRefetch` bus now exported from the root
entry, lets a write trigger the polled queries reading the same key to refetch
immediately. React remains an optional peer dependency and the root entry stays
framework free.
