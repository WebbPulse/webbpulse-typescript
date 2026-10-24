---
'@webbpulse/auth': minor
---

`AccountSession` gains an optional `browser`, the coarse browser family webbpulse's `GET /sessions` now reports, such as `Chrome`, `Safari` or `Edge`, never a version (PLAT-83). `parseAccountSessions` reads it, and it is an empty string for a non-browser client or a server that predates the field.
