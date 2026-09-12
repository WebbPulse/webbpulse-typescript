# @webbpulse/qrcode

A QR encoder for the short URIs an application renders inline, such as the
`otpauth://` provisioning URI a TOTP enrolment panel shows. Framework free, zero
runtime dependencies.

```ts
import { qrCodeSvgPath } from '@webbpulse/qrcode';

const { path, viewBox } = qrCodeSvgPath(enrolment.provisioningUri);

<svg viewBox={viewBox} role="img" aria-label="Scan this with your authenticator">
  <rect width="100%" height="100%" fill="white" />
  <path d={path} fill="black" />
</svg>;
```

## Why a local encoder rather than a dependency

The one thing this renders is a TOTP secret, which must not leave the page. A QR
library large enough to cover every mode, version and error correction level is
a large amount of third party code in the blast radius of the most sensitive
string the application handles. This covers the case that exists: byte mode,
error correction level M, versions 1 to 10.

Version 10 at level M holds 213 bytes, which is comfortably more than any
provisioning URI. Longer text throws rather than silently producing a symbol no
scanner can read.

## What it implements

- Byte mode with the version 1 to 10 level M block layouts, Reed Solomon error
  correction over GF(256), and the block interleaving the standard requires so a
  burst of damage spreads across blocks instead of destroying one outright.
- The finder, alignment and timing patterns, the format information with its BCH
  code, and the two version information blocks for versions 7 and up.
- All eight mask patterns, scored by the standard's four penalty rules rather
  than fixed, so the chosen mask is the one a scanner reads most reliably. The
  choice is deterministic: the same text always produces the same matrix.

## Exports

`encodeQrCode(text)` returns the `QrMatrix`, a `size` and a `size` by `size`
array of booleans with `true` being dark, for a caller that wants to draw the
modules itself.

`qrCodeSvgPath(text)` returns `{ path, viewBox, size }`, where `path` is one SVG
path `d` attribute covering every dark module and `viewBox` carries the four
module quiet zone the standard requires. One path rather than one rect per
module, which for a version 4 symbol is a few hundred nodes fewer.
