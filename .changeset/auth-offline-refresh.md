---
'@webbpulse/auth': minor
---

Keep the session through a refresh that fails at the network layer: the user and status stay, the token is dropped at its expiry, and the refresh runs again when the connection returns. A startup refresh that failed offline runs again on reconnect (PLAT-93).
