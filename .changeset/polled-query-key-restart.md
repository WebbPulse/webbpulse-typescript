---
'@webbpulse/api-client': minor
---

`usePolledQuery` now treats `queryKey` as the identity of the query rather than
only its invalidation channel, so a caller whose key changes because its filters
or page cursor changed re-reads instead of showing the previous key's data
forever. A key change resets the timer and any backoff, fetches immediately,
moves the refetch subscription to the new key, and drops a response still in
flight for the old key; `data` clears and `isLoading` reads true until the new
result lands, because the old rows answer a different question. `QueryKey` now
accepts an array of primitives alongside a string and keys compare by a stable
serialisation, so an array assembled inline on every render restarts nothing.
Adopters that remounted a list on a React `key` to force a re-read can drop that
workaround, and a caller whose key never changes is unaffected.
