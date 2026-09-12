# @webbpulse/qrcode

## 0.9.0

### Minor Changes

- Hoist the frontend primitives both applications had written twice.

  - `@webbpulse/qrcode`, new: a dependency free byte mode QR encoder for the short URIs a page renders inline, such as a TOTP provisioning URI. Exports `encodeQrCode`, `qrCodeSvgPath` and `QrMatrix`.
  - `@webbpulse/discovery`, new: what a deployment of the identity service can actually do, read before a sign-in page decides what to render. Tri-state `Availability`, one uncredentialed read per page load keyed on the full URL, passkey capability and OAuth provider gates.
  - `useOAuthCallback` on the `@webbpulse/auth` `./react` entry point: runs a handler once when the page was an OAuth callback landing, then strips the single-use parameters so a reload cannot replay a live MFA ticket.

  Every package lands on the same minor so the set stays in lockstep.
