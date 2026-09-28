---
'@webbpulse/auth': minor
---

`OAuthLink` gains an optional `login`, the provider username (the GitHub login) that `GET /oauth/links` returns from webbpulse 0.65, so a connected accounts section can show `@octocat` rather than only the provider email. `parseOAuthLinks` sets it only when the server sent a non-empty string.
