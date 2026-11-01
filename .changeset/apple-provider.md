---
'@webbpulse/auth': minor
---

Adds `APPLE_PROVIDER` for Sign in with Apple (PLAT-107), the server provider added in `webbpulse` 0.111.0. Every OAuth method already takes a plain string provider, so nothing else changes. `providerLabel` in `@webbpulse/discovery` already renders it as `Apple`.
