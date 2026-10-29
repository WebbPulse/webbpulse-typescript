---
'@webbpulse/api-client': minor
'@webbpulse/auth': minor
---

Probe before marking offline (PLAT-100). The shared reachability signal now probes the API on a network failure, backing off from 1s doubling to 30s, and reads offline only after a 15s grace period or at once when `navigator.onLine` is false. Focus, visibility and the browser `online` event re-probe. New `configureReachability({ graceMs, probeBaseMs, probeMaxMs, probe })`, `probeReachabilityNow`, `subscribeToNetworkRecovery` and the client option `probePath` (default `'/'`, null for none). `{ graceMs: 0, probe: false }` restores the old behaviour. The auth client retries a refresh that failed at the network layer on its own with backoff (`refreshRetryBaseMs`, default 1000, and `refreshRetryMaxMs`, default 30000), and at once when the network answers again, stopping on success, sign-out, dispose or a non-network failure.
