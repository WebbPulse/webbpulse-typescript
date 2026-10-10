---
'@webbpulse/auth': minor
---

Browser to desktop session handoff, the client side of webbpulse's `/desktop-handoff` routes. The desktop app calls `createDesktopHandoffPkce()` and opens `desktopHandoffLaunchUrl(...)` in the system browser. The handoff page calls `AuthClient.handOffToDesktop()` (or `mintDesktopHandoff({ codeChallenge, scheme })`) and opens the returned `callbackUrl`, `<scheme>://auth/handoff?code=...`. The app then calls `completeDesktopHandoff({ url, codeVerifier })` (or `exchangeDesktopHandoff({ code, codeVerifier, scheme })`), which adopts the session as a sign-in would. Both sides refuse a scheme off the new `desktopHandoffSchemes` option, which is empty by default and throws on a web scheme. Both resolve to outcome unions rather than throwing. New `AuthPaths` entries `desktopHandoff` and `desktopHandoffExchange`. `HANDOFF_SCHEME_NOT_ALLOWED`, `HANDOFF_INVALID_REQUEST`, `HANDOFF_INVALID` and `HANDOFF_DISABLED` join `AUTH_ERROR_CODES`.
