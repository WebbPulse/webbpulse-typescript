/**
 * A dependency free QR encoder for the short URIs an application renders
 * inline, such as a TOTP provisioning URI. Byte mode, error correction level M,
 * versions 1 to 10, with the mask chosen by the standard's four penalty rules.
 */

const EC_LEVEL_M = 'M';

const MAX_VERSION = 10;

const VERSION_SPECS_M: readonly (readonly [number, number, number, number])[] =
  [
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

/** A square matrix of modules, `true` being dark. */
export interface QrMatrix {
  size: number;
  modules: boolean[][];
}

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) {
      x ^= 0x11d;
    }
  }
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255] as number;
  }
})();

function gfMultiply(a: number, b: number): number {
  if (a === 0 || b === 0) {
    return 0;
  }
  return GF_EXP[(GF_LOG[a] as number) + (GF_LOG[b] as number)] as number;
}

function generatorPolynomial(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] = (next[j] as number) ^ (poly[j] as number);
      next[j + 1] =
        (next[j + 1] as number) ^
        gfMultiply(poly[j] as number, GF_EXP[i] as number);
    }
    poly = next;
  }
  return poly;
}

function errorCorrectionCodewords(data: number[], count: number): number[] {
  const generator = generatorPolynomial(count);
  const remainder = new Array<number>(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ (remainder[0] as number);
    remainder.shift();
    remainder.push(0);
    for (let i = 0; i < generator.length - 1; i += 1) {
      remainder[i] =
        (remainder[i] as number) ^
        gfMultiply(generator[i + 1] as number, factor);
    }
  }
  return remainder;
}

class BitBuffer {
  private readonly bits: number[] = [];

  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) {
      this.bits.push((value >>> i) & 1);
    }
  }

  get length(): number {
    return this.bits.length;
  }

  toCodewords(): number[] {
    const padded = [...this.bits];
    while (padded.length % 8 !== 0) {
      padded.push(0);
    }
    const bytes: number[] = [];
    for (let i = 0; i < padded.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j += 1) {
        byte = (byte << 1) | (padded[i + j] as number);
      }
      bytes.push(byte);
    }
    return bytes;
  }
}

function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const spec = VERSION_SPECS_M[version - 1] as readonly [
      number,
      number,
      number,
      number,
    ];
    const countBits = version <= 9 ? 8 : 16;
    const needed = 4 + countBits + byteLength * 8;
    if (needed <= spec[0] * 8) {
      return version;
    }
  }
  throw new Error(
    `That value is ${byteLength} bytes, which is more than a version ${MAX_VERSION} QR code holds at error correction level ${EC_LEVEL_M}.`
  );
}

function buildCodewords(data: Uint8Array, version: number): number[] {
  const spec = VERSION_SPECS_M[version - 1] as readonly [
    number,
    number,
    number,
    number,
  ];
  const [totalData, ecPerBlock, group1Blocks, group2Blocks] = spec;
  const totalBlocks = group1Blocks + group2Blocks;
  const group1Size = Math.floor(totalData / totalBlocks);

  const buffer = new BitBuffer();
  buffer.put(0b0100, 4);
  buffer.put(data.length, version <= 9 ? 8 : 16);
  for (const byte of data) {
    buffer.put(byte, 8);
  }
  const remaining = totalData * 8 - buffer.length;
  buffer.put(0, Math.min(4, Math.max(0, remaining)));

  const codewords = buffer.toCodewords();
  const padBytes = [0xec, 0x11];
  let padIndex = 0;
  while (codewords.length < totalData) {
    codewords.push(padBytes[padIndex % 2] as number);
    padIndex += 1;
  }

  const dataBlocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (let block = 0; block < totalBlocks; block += 1) {
    const size = block < group1Blocks ? group1Size : group1Size + 1;
    const blockData = codewords.slice(offset, offset + size);
    offset += size;
    dataBlocks.push(blockData);
    ecBlocks.push(errorCorrectionCodewords(blockData, ecPerBlock));
  }

  const result: number[] = [];
  const longestData = Math.max(...dataBlocks.map((block) => block.length));
  for (let i = 0; i < longestData; i += 1) {
    for (const block of dataBlocks) {
      if (i < block.length) {
        result.push(block[i] as number);
      }
    }
  }
  for (let i = 0; i < ecPerBlock; i += 1) {
    for (const block of ecBlocks) {
      result.push(block[i] as number);
    }
  }
  return result;
}

type Reserved = boolean[][];

function emptyGrid(size: number): boolean[][] {
  return Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false)
  );
}

function placeFinderPattern(
  modules: boolean[][],
  reserved: Reserved,
  row: number,
  col: number
): void {
  for (let r = -1; r <= 7; r += 1) {
    for (let c = -1; c <= 7; c += 1) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || rr >= modules.length || cc < 0 || cc >= modules.length) {
        continue;
      }
      const inRing = (r === 0 || r === 6) && c >= 0 && c <= 6;
      const inSide = (c === 0 || c === 6) && r >= 0 && r <= 6;
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      (modules[rr] as boolean[])[cc] = inRing || inSide || inCore;
      (reserved[rr] as boolean[])[cc] = true;
    }
  }
}

function placeAlignmentPatterns(
  modules: boolean[][],
  reserved: Reserved,
  version: number
): void {
  const centres = ALIGNMENT_CENTRES[version - 1] as readonly number[];
  const size = modules.length;
  for (const row of centres) {
    for (const col of centres) {
      const nearFinder =
        (row <= 8 && col <= 8) ||
        (row <= 8 && col >= size - 9) ||
        (row >= size - 9 && col <= 8);
      if (nearFinder) {
        continue;
      }
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          (modules[row + r] as boolean[])[col + c] = dark;
          (reserved[row + r] as boolean[])[col + c] = true;
        }
      }
    }
  }
}

function placeTimingPatterns(modules: boolean[][], reserved: Reserved): void {
  const size = modules.length;
  for (let i = 8; i < size - 8; i += 1) {
    const dark = i % 2 === 0;
    (modules[6] as boolean[])[i] = dark;
    (reserved[6] as boolean[])[i] = true;
    (modules[i] as boolean[])[6] = dark;
    (reserved[i] as boolean[])[6] = true;
  }
}

function reserveFormatAreas(modules: boolean[][], reserved: Reserved): void {
  const size = modules.length;
  for (let i = 0; i < 9; i += 1) {
    if (!((reserved[8] as boolean[])[i] as boolean)) {
      (reserved[8] as boolean[])[i] = true;
    }
    if (!((reserved[i] as boolean[])[8] as boolean)) {
      (reserved[i] as boolean[])[8] = true;
    }
  }
  for (let i = 0; i < 8; i += 1) {
    (reserved[8] as boolean[])[size - 1 - i] = true;
    (reserved[size - 1 - i] as boolean[])[8] = true;
  }
  (modules[size - 8] as boolean[])[8] = true;
  (reserved[size - 8] as boolean[])[8] = true;
}

function placeData(
  modules: boolean[][],
  reserved: Reserved,
  codewords: number[],
  mask: number
): void {
  const size = modules.length;
  let bitIndex = 0;
  let upward = true;

  for (let right = size - 1; right >= 1; right -= 2) {
    const rightCol = right <= 6 ? right - 1 : right;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let c = 0; c < 2; c += 1) {
        const col = rightCol - c;
        if ((reserved[row] as boolean[])[col] as boolean) {
          continue;
        }
        const byte = codewords[bitIndex >>> 3];
        const bit =
          byte === undefined ? 0 : (byte >>> (7 - (bitIndex & 7))) & 1;
        bitIndex += 1;
        (modules[row] as boolean[])[col] =
          bit === 1 ? !maskAt(mask, row, col) : maskAt(mask, row, col);
      }
    }
    upward = !upward;
  }
}

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

function formatBits(mask: number): number {
  const data = (0b00 << 3) | mask;
  let value = data << 10;
  for (let i = 4; i >= 0; i -= 1) {
    if ((value >>> (10 + i)) & 1) {
      value ^= 0b10100110111 << i;
    }
  }
  return ((data << 10) | value) ^ 0b101010000010010;
}

function placeFormatInformation(modules: boolean[][], mask: number): void {
  const size = modules.length;
  const bits = formatBits(mask);
  for (let i = 0; i < 15; i += 1) {
    const dark = ((bits >>> i) & 1) === 1;
    if (i < 6) {
      (modules[i] as boolean[])[8] = dark;
    } else if (i < 8) {
      (modules[i + 1] as boolean[])[8] = dark;
    } else {
      (modules[size - 15 + i] as boolean[])[8] = dark;
    }
    if (i < 8) {
      (modules[8] as boolean[])[size - 1 - i] = dark;
    } else if (i < 9) {
      (modules[8] as boolean[])[15 - i - 1 + 1] = dark;
    } else {
      (modules[8] as boolean[])[15 - i - 1] = dark;
    }
  }
}

function placeVersionInformation(
  modules: boolean[][],
  reserved: Reserved,
  version: number
): void {
  if (version < 7) {
    return;
  }
  const size = modules.length;
  let value = version << 12;
  for (let i = 5; i >= 0; i -= 1) {
    if ((value >>> (12 + i)) & 1) {
      value ^= 0x1f25 << i;
    }
  }
  const bits = (version << 12) | (value & 0xfff);

  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >>> i) & 1) === 1;
    const row = Math.floor(i / 3);
    const col = size - 11 + (i % 3);
    (modules[row] as boolean[])[col] = dark;
    (reserved[row] as boolean[])[col] = true;
    (modules[col] as boolean[])[row] = dark;
    (reserved[col] as boolean[])[row] = true;
  }
}

function penaltyScore(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;

  for (let i = 0; i < size; i += 1) {
    for (const readRow of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j += 1) {
        const current = readRow
          ? ((modules[i] as boolean[])[j] as boolean)
          : ((modules[j] as boolean[])[i] as boolean);
        const previous = readRow
          ? ((modules[i] as boolean[])[j - 1] as boolean)
          : ((modules[j - 1] as boolean[])[i] as boolean);
        if (current === previous) {
          run += 1;
        } else {
          if (run >= 5) {
            score += run - 2;
          }
          run = 1;
        }
      }
      if (run >= 5) {
        score += run - 2;
      }
    }
  }

  for (let r = 0; r < size - 1; r += 1) {
    for (let c = 0; c < size - 1; c += 1) {
      const value = (modules[r] as boolean[])[c] as boolean;
      if (
        ((modules[r] as boolean[])[c + 1] as boolean) === value &&
        ((modules[r + 1] as boolean[])[c] as boolean) === value &&
        ((modules[r + 1] as boolean[])[c + 1] as boolean) === value
      ) {
        score += 3;
      }
    }
  }

  const pattern = [true, false, true, true, true, false, true];
  const quiet = [false, false, false, false];
  const matchesAt = (line: boolean[], start: number, seq: boolean[]): boolean =>
    seq.every((value, index) => line[start + index] === value);
  const lines: boolean[][] = [];
  for (let i = 0; i < size; i += 1) {
    lines.push(modules[i] as boolean[]);
    lines.push(modules.map((row) => row[i] as boolean));
  }
  for (const line of lines) {
    for (let i = 0; i + 7 <= line.length; i += 1) {
      if (!matchesAt(line, i, pattern)) {
        continue;
      }
      const before = i - 4 >= 0 && matchesAt(line, i - 4, quiet);
      const after = i + 11 <= line.length && matchesAt(line, i + 7, quiet);
      if (before || after) {
        score += 40;
      }
    }
  }

  let dark = 0;
  for (const row of modules) {
    for (const value of row) {
      if (value) {
        dark += 1;
      }
    }
  }
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/**
 * Encodes `text` as a QR matrix, choosing the smallest version that holds it
 * and the lowest penalty mask. Throws when the text exceeds a version 10 level
 * M symbol.
 */
export function encodeQrCode(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const codewords = buildCodewords(bytes, version);
  const size = version * 4 + 17;

  let best: boolean[][] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let mask = 0; mask < 8; mask += 1) {
    const modules = emptyGrid(size);
    const reserved = emptyGrid(size);
    placeFinderPattern(modules, reserved, 0, 0);
    placeFinderPattern(modules, reserved, 0, size - 7);
    placeFinderPattern(modules, reserved, size - 7, 0);
    placeAlignmentPatterns(modules, reserved, version);
    placeTimingPatterns(modules, reserved);
    reserveFormatAreas(modules, reserved);
    placeVersionInformation(modules, reserved, version);
    placeData(modules, reserved, codewords, mask);
    placeFormatInformation(modules, mask);

    const score = penaltyScore(modules);
    if (score < bestScore) {
      bestScore = score;
      best = modules;
    }
  }

  return { size, modules: best as boolean[][] };
}

/**
 * Renders the matrix as one SVG path `d` attribute, with the `viewBox` and
 * padded size carrying the four module quiet zone the standard requires. One
 * path rather than a rect per module.
 */
export function qrCodeSvgPath(text: string): {
  path: string;
  viewBox: string;
  size: number;
} {
  const { size, modules } = encodeQrCode(text);
  const quiet = 4;
  const parts: string[] = [];
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      if ((modules[row] as boolean[])[col] as boolean) {
        parts.push(`M${col + quiet} ${row + quiet}h1v1h-1z`);
      }
    }
  }
  const total = size + quiet * 2;
  return {
    path: parts.join(''),
    viewBox: `0 0 ${total} ${total}`,
    size: total,
  };
}
