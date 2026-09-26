---
'@webbpulse/api-client': minor
---

`usePolledQuery` can no longer stall for good. Each attempt now runs under a
deadline covering the whole of it, the `waitForToken` wait and the fetcher
including any token refresh and the body read, set by the new
`attemptTimeoutMs` option (default `DEFAULT_ATTEMPT_TIMEOUT_MS`, 30 seconds, 0
disables it). An attempt that outlives it is aborted through its signal, rejects
with the new `PolledQueryTimeoutError`, counts as a failure for backoff, and the
next poll starts a new attempt; an in-flight attempt past its deadline is never
handed to a later `refetch`, focus or visibility trigger, which also covers a
background tab whose timers were throttled. `DEFAULT_MAX_BACKOFF_MS` drops from
five minutes to 15 seconds, and the backoff never falls below `intervalMs`. A
new watchdog restarts polling when no attempt has started or settled within
`stallTimeoutMs` (default `max(intervalMs, maxBackoffMs)` plus the attempt
deadline, 0 disables it); it only fires while the document is visible, checks
again the moment it returns to visible, and is torn down on unmount. Callers
that wrapped their fetcher in their own deadline and watchdog can drop that
workaround.
