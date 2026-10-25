---
'@webbpulse/api-client': minor
---

Query persistence fills the gaps Standupless hit adopting it (PLAT-93). `persistPolledQueryCache` takes `exclude`, key prefixes read like `prefixes`, so a key under a persisted prefix can be kept out; an excluded key is never written and its stored record is dropped on load. `clearAllPersistedPolledQueries(store?)` stops the running persister and deletes every namespace, for sign out, and `listPersistedNamespaces(store?)` lists them; both never reject. `QueryCacheStore` gains optional `listNamespaces()` and `clearAll()`, which the IndexedDB and memory stores implement. Every mounted `usePolledQuery` now refetches as soon as the online signal flips back to online, instead of waiting for its next poll or error backoff.
