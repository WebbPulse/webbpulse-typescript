---
'@webbpulse/auth': minor
---

Hold desktop handoff state across a browser sign-in (PLAT-105). `createDesktopHandoffVerifierStore` is a single-use, expiring holder for the app side's PKCE verifier, in memory by default or in local storage with a `storageKey` for a shell the operating system can stop. `createDesktopHandoffReturnStore` keeps the handoff page's request across a mailed link and only answers paths on that page. `isDesktopHandoffCallback` matches a callback with or without a usable code.
