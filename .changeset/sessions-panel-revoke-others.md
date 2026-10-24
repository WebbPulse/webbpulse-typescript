---
'@webbpulse/auth': minor
---

`AuthClient.revokeOtherSessions()` calls webbpulse's new `POST /sessions/revoke-others` and resolves to `{ ok: true, revoked }`, with the path configurable as `paths.sessionsRevokeOthers` (PLAT-82). `useAuth` exposes it too. `@webbpulse/auth/panels` gains `useSessionsPanel`, a headless sessions panel that lists `AccountSession`s with the calling one split out as `current`, ends one with `revoke` and every other one with `revokeOthers`, and `ListPanel` gains `mutate` for a call the panel does not model.
