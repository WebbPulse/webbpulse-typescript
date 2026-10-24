---
'@webbpulse/api-client': patch
---

Documents the test setup the module scoped `usePolledQuery` cache needs: call `clearPolledQueryCache()` in `afterEach`, after Testing Library's `cleanup()`, so cached reads do not leak between tests. The README gains a Testing section with a vitest setup snippet and the `clearPolledQueryCache` docstring mentions the test use. No code changes. Fixes PLAT-77.
