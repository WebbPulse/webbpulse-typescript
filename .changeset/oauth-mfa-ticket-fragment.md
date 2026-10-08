---
'@webbpulse/auth': minor
---

`readOAuthCallback` reads the OAuth MFA ticket from the URL fragment (`#mfa_ticket=<t>`, where webbpulse 0.80.0 puts it) and falls back to the query for older servers. `stripOAuthParams` also removes the fragment ticket, keeping other fragment content and dropping an empty `#`. Both now accept a `URL` or `Location` as well as an href string (new `OAuthCallbackHref` type). Callers must pass something that includes the hash, such as `location.href`, never `location.search`; `useOAuthCallback` already does.
