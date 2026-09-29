---
'@webbpulse/api-client': patch
---

`usePolledQuery` derives `isLoading` from whether the query is enabled and a fetch for the current key has settled. A query enabled after its first render now reads loading until its first data or error arrives instead of reporting false with no data, and a query disabled before its first fetch settled no longer stays loading. Background and hidden-tab polls still never raise it.
