---
'@webbpulse/auth': patch
---

`usePasskeySignInButton` aborts the armed autofill (conditional mediation) request before a click starts its own ceremony, and arms it again afterwards unless the click signed the person in. A browser refuses a second WebAuthn request while one is pending, so in Chromium the button failed with "A request is already pending" on every page that armed autofill.
