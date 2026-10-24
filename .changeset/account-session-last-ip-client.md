---
'@webbpulse/auth': minor
---

`AccountSession` gains `lastIp`, `client`, `platform` and `clientId`, read from the `last_ip`, `client`, `platform` and `client_id` fields that webbpulse 0.99.0's `GET /sessions` adds (PLAT-79). `lastIp` falls back to `ip` when the body has none, and the other three are empty strings when unknown.
