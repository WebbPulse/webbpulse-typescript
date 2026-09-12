import { describe, expect, it } from 'vitest';

import { encodeQrCode, qrCodeSvgPath, type QrMatrix } from './index.js';

const CMP_URI =
  'otpauth://totp/CarModPicker:someone@example.test?secret=JBSWY3DPEHPK3PXP&issuer=CarModPicker';

const PORTFOLIO_URI =
  'otpauth://totp/WebbPulse%20Portfolio:tyler@webbpulse.com?secret=JBSWY3DPEHPK3PXP&issuer=WebbPulse%20Portfolio&algorithm=SHA1&digits=6&period=30';

const SHORT_URI = 'otpauth://totp/a?secret=JBSWY3DPEHPK3PXP';

const VERSION_SPECS: readonly (readonly [number, number, number, number])[] = [
  [16, 10, 1, 0],
  [28, 16, 1, 0],
  [44, 26, 1, 0],
  [64, 18, 2, 0],
  [86, 24, 2, 0],
  [108, 16, 4, 0],
  [124, 18, 4, 0],
  [154, 22, 2, 2],
  [182, 22, 3, 2],
  [216, 26, 4, 1],
];

const ALIGNMENT_CENTRES: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

function maskAt(pattern: number, row: number, col: number): boolean {
  switch (pattern) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row + col) % 2) + ((row * col) % 3)) % 2 === 0;
  }
}

function reservedFor(size: number, version: number): boolean[][] {
  const reserved: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false)
  );
  const finder = (row: number, col: number) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const rr = row + r;
        const cc = col + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        reserved[rr]![cc] = true;
      }
    }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);

  const centres = ALIGNMENT_CENTRES[version - 1]!;
  for (const row of centres) {
    for (const col of centres) {
      const nearFinder =
        (row <= 8 && col <= 8) ||
        (row <= 8 && col >= size - 9) ||
        (row >= size - 9 && col <= 8);
      if (nearFinder) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          reserved[row + r]![col + c] = true;
        }
      }
    }
  }
  for (let i = 8; i < size - 8; i += 1) {
    reserved[6]![i] = true;
    reserved[i]![6] = true;
  }
  for (let i = 0; i < 9; i += 1) {
    reserved[8]![i] = true;
    reserved[i]![8] = true;
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[8]![size - 1 - i] = true;
    reserved[size - 1 - i]![8] = true;
  }
  reserved[size - 8]![8] = true;
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const row = Math.floor(i / 3);
      const col = size - 11 + (i % 3);
      reserved[row]![col] = true;
      reserved[col]![row] = true;
    }
  }
  return reserved;
}

function readCodewords(
  modules: boolean[][],
  reserved: boolean[][],
  mask: number
): number[] {
  const size = modules.length;
  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    const rightCol = right <= 6 ? right - 1 : right;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let c = 0; c < 2; c += 1) {
        const col = rightCol - c;
        if (reserved[row]![col]!) continue;
        const value = modules[row]![col]!;
        bits.push(maskAt(mask, row, col) ? (value ? 0 : 1) : value ? 1 : 0);
      }
    }
    upward = !upward;
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j]!;
    bytes.push(byte);
  }
  return bytes;
}

function deinterleave(stream: number[], version: number): number[] {
  const [totalData, , group1Blocks, group2Blocks] = VERSION_SPECS[version - 1]!;
  const totalBlocks = group1Blocks + group2Blocks;
  const group1Size = Math.floor(totalData / totalBlocks);
  const sizes = Array.from({ length: totalBlocks }, (_, i) =>
    i < group1Blocks ? group1Size : group1Size + 1
  );

  const blocks: number[][] = sizes.map(() => []);
  let at = 0;
  const longest = Math.max(...sizes);
  for (let i = 0; i < longest; i += 1) {
    for (let b = 0; b < totalBlocks; b += 1) {
      if (i < sizes[b]!) blocks[b]!.push(stream[at++]!);
    }
  }
  return blocks.flat();
}

function decodePayload(matrix: QrMatrix): string {
  const { size, modules } = matrix;
  const version = (size - 17) / 4;

  let raw = 0;
  for (let i = 0; i < 15; i += 1) {
    let dark: boolean;
    if (i < 6) dark = modules[i]![8]!;
    else if (i < 8) dark = modules[i + 1]![8]!;
    else dark = modules[size - 15 + i]![8]!;
    if (dark) raw |= 1 << i;
  }
  const unmasked = raw ^ 0b101010000010010;
  const mask = (unmasked >>> 10) & 0b111;

  const interleaved = readCodewords(modules, reservedFor(size, version), mask);
  const codewords = deinterleave(interleaved, version);
  const mode = (codewords[0]! >>> 4) & 0b1111;
  expect(mode).toBe(0b0100);
  const countBits = version <= 9 ? 8 : 16;

  const bits: number[] = [];
  for (const byte of codewords) {
    for (let i = 7; i >= 0; i -= 1) bits.push((byte >>> i) & 1);
  }
  let at = 4;
  let length = 0;
  for (let i = 0; i < countBits; i += 1) length = (length << 1) | bits[at++]!;

  const out: number[] = [];
  for (let i = 0; i < length; i += 1) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[at++]!;
    out.push(byte);
  }
  return new TextDecoder().decode(new Uint8Array(out));
}

function hasFinderAt(modules: boolean[][], row: number, col: number): boolean {
  for (let r = 0; r < 7; r += 1) {
    for (let c = 0; c < 7; c += 1) {
      const onBorder = r === 0 || r === 6 || c === 0 || c === 6;
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      if (modules[row + r]![col + c] !== (onBorder || inCore)) return false;
    }
  }
  return true;
}

describe('encodeQrCode', () => {
  it('produces a square matrix at a valid version size', () => {
    const { size, modules } = encodeQrCode(CMP_URI);
    expect((size - 17) % 4).toBe(0);
    const version = (size - 17) / 4;
    expect(version).toBeGreaterThanOrEqual(1);
    expect(version).toBeLessThanOrEqual(10);
    expect(modules).toHaveLength(size);
    for (const row of modules) expect(row).toHaveLength(size);
  });

  it('places the three finder patterns the standard requires', () => {
    const { size, modules } = encodeQrCode(CMP_URI);
    expect(hasFinderAt(modules, 0, 0)).toBe(true);
    expect(hasFinderAt(modules, 0, size - 7)).toBe(true);
    expect(hasFinderAt(modules, size - 7, 0)).toBe(true);
  });

  it('leaves the fourth corner free of a finder pattern', () => {
    const { size, modules } = encodeQrCode(CMP_URI);
    expect(hasFinderAt(modules, size - 7, size - 7)).toBe(false);
  });

  it('lays down the alternating timing patterns', () => {
    const { size, modules } = encodeQrCode(CMP_URI);
    for (let i = 8; i < size - 8; i += 1) {
      expect(modules[6]![i]).toBe(i % 2 === 0);
      expect(modules[i]![6]).toBe(i % 2 === 0);
    }
  });

  it('grows the symbol as the text gets longer', () => {
    const small = encodeQrCode('a');
    const large = encodeQrCode('a'.repeat(200));
    expect(large.size).toBeGreaterThan(small.size);
  });

  it('encodes the shortest input at the smallest version', () => {
    expect(encodeQrCode('a').size).toBe(21);
  });

  it('is deterministic, since mask selection is scored not random', () => {
    expect(encodeQrCode(CMP_URI).modules).toEqual(
      encodeQrCode(CMP_URI).modules
    );
  });

  it('produces a mixture of light and dark modules', () => {
    const flat = encodeQrCode(CMP_URI).modules.flat();
    expect(flat.some((module) => module)).toBe(true);
    expect(flat.some((module) => !module)).toBe(true);
  });

  it('round trips a long provisioning URI out of the data region', () => {
    expect(decodePayload(encodeQrCode(PORTFOLIO_URI))).toBe(PORTFOLIO_URI);
  });

  it('round trips a short value, which lands on a smaller version', () => {
    expect(decodePayload(encodeQrCode(SHORT_URI))).toBe(SHORT_URI);
  });

  it('refuses text longer than a version 10 symbol holds', () => {
    expect(() => encodeQrCode('x'.repeat(400))).toThrow(/more than a version/i);
  });
});

describe('qrCodeSvgPath', () => {
  it('adds the four module quiet zone on every side', () => {
    const { size } = qrCodeSvgPath(CMP_URI);
    expect(size).toBe(encodeQrCode(CMP_URI).size + 8);
  });

  it('reports a viewBox matching the padded size', () => {
    const { viewBox, size } = qrCodeSvgPath(CMP_URI);
    expect(viewBox).toBe(`0 0 ${String(size)} ${String(size)}`);
  });

  it('emits one path box per dark module', () => {
    const { path } = qrCodeSvgPath(CMP_URI);
    const dark = encodeQrCode(CMP_URI).modules.flat().filter(Boolean).length;
    expect(path.split('M').length - 1).toBe(dark);
  });

  it('starts the path with a move, and never at the quiet zone origin', () => {
    const { path } = qrCodeSvgPath(CMP_URI);
    expect(path.startsWith('M')).toBe(true);
    expect(path).not.toContain('M0 0h');
  });

  it('keeps every box inside the padded viewBox', () => {
    const { path, size } = qrCodeSvgPath(CMP_URI);
    for (const [, x, y] of path.matchAll(/M(\d+) (\d+)h/g)) {
      expect(Number(x)).toBeGreaterThanOrEqual(4);
      expect(Number(y)).toBeGreaterThanOrEqual(4);
      expect(Number(x)).toBeLessThan(size - 4);
      expect(Number(y)).toBeLessThan(size - 4);
    }
  });
});
