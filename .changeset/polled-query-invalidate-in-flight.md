---
'@webbpulse/api-client': minor
---

`usePolledQuery` no longer drops an `invalidateQueries(key)` that lands while a read for the key is in flight. That read was sent before the write, so once it settles the query reads once more and the follow-up's answer wins; any number of invalidations during one read queue a single follow-up, shared across mounts on the key. Each shared read now carries a sequence number, and a read that settles after a later one has landed writes nothing and keeps the newer data. The public API is unchanged. Fixes PLAT-69.
