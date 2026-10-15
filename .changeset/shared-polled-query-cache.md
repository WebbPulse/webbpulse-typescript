---
'@webbpulse/api-client': minor
---

`usePolledQuery` keyed queries now share a module scoped stale-while-revalidate cache holding data, ETag and read time per key. A mount or key change on a cached key paints at once and revalidates once stale, mounts on one key share one read and one poll, and the held ETag makes a remount revalidate with a 304. New exports `clearPolledQueryCache`, `prefetchPolledQuery`, `PrefetchPolledQueryOptions` and `DEFAULT_CACHE_TIME_MS`, and a `cacheTimeMs` option for eviction once no query holds an entry (default 5 minutes). Refs PLAT-62.
