---
'@webbpulse/auth': minor
---

Add the client side of sessions for unverified accounts (PLAT-106). `AuthClient.signUp` registers and adopts an issued session, `AuthClient.refreshSession` (also on `useAuth`) rotates the token before re-reading the user so a changed claim reaches the token, and `useEmailVerificationWatch` and `useEmailVerificationResend` in `@webbpulse/auth/react` cover noticing a link opened elsewhere and a resend with a cooldown. `register` and `reloadUser` are unchanged.
