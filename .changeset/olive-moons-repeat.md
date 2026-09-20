---
'@webbpulse/discovery': patch
---

Float the `@webbpulse/auth` dependency on a caret range instead of pinning it
exactly, so a consumer floating the same package resolves one copy rather than
two.
