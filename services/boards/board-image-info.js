'use strict';

// What a picture's first bytes say it is (row 150 slice B7, plan PROJECT_BOARD_2026-11-13 section 6.1): PNG, JPEG,
// WebP or GIF, decided by content only (never a name or a declared type), and its width and height read from the
// header. A pure, bounded parser: it never decodes pixels, never throws, and reads at most JPEG_MAX_SEGMENTS segment
// headers. Anything else (SVG, HTML, text, an empty buffer, a truncated or hostile header) is `unsupported`; a header
// that reads but names a size the board model refuses is `dimensions`.
//
// imageInfo(bytes) -> { ok: true, ext, mime, width, height } | { ok: false, reason: 'unsupported' | 'dimensions' }

// The board model's IMAGE_DIM_MAX (services/boards/board-model.js keeps it private); tests/board-assets.test.js pins
// that the two agree through the model's own applyBatch.
const IMAGE_DIM_MAX = 100000;
const JPEG_MAX_SEGMENTS = 4096;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const TYPES = Object.freeze({
  png: Object.freeze({ ext: 'png', mime: 'image/png' }),
  jpeg: Object.freeze({ ext: 'jpg', mime: 'image/jpeg' }),
  webp: Object.freeze({ ext: 'webp', mime: 'image/webp' }),
  gif: Object.freeze({ ext: 'gif', mime: 'image/gif' }),
});
const MIME_BY_EXT = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' });

const ascii = (b, start, end) => (b.length >= end ? String.fromCharCode(...b.subarray(start, end)) : '');
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u16le = (b, i) => b[i] | (b[i + 1] << 8);
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b, i) => ((b[i] << 24) >>> 0) + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);

function typeOf(b) {
  if (b.length >= 8 && PNG_SIGNATURE.every((byte, i) => b[i] === byte)) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'webp';
  const gif = ascii(b, 0, 6);
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'gif';
  return null;
}

// The IHDR chunk must come first, with its fixed length of 13.
function pngSize(b) {
  if (b.length < 24 || u32be(b, 8) !== 13 || ascii(b, 12, 16) !== 'IHDR') return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function gifSize(b) {
  return b.length >= 10 ? { width: u16le(b, 6), height: u16le(b, 8) } : null;
}

function webpSize(b) {
  const chunk = ascii(b, 12, 16);
  if (chunk === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && b.length >= 30) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  return null;
}

// Walks the segment headers to the first start-of-frame marker (C0-CF but DHT C4, JPG C8 and DAC CC).
function jpegSize(b) {
  let i = 2;
  for (let steps = 0; steps < JPEG_MAX_SEGMENTS && i + 1 < b.length; steps += 1) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0xda) return null; // a second start, the end, or scan data first
    if (i + 4 > b.length) return null;
    const length = u16be(b, i + 2);
    if (length < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return length >= 7 && i + 9 <= b.length ? { width: u16be(b, i + 7), height: u16be(b, i + 5) } : null;
    }
    i += 2 + length;
  }
  return null;
}

const SIZERS = { png: pngSize, jpeg: jpegSize, webp: webpSize, gif: gifSize };

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

function imageInfo(value) {
  try {
    const bytes = asBytes(value);
    const type = bytes ? typeOf(bytes) : null;
    if (!type) return { ok: false, reason: 'unsupported' };
    const size = SIZERS[type](bytes);
    if (!size || !Number.isInteger(size.width) || !Number.isInteger(size.height)) return { ok: false, reason: 'unsupported' };
    if (size.width < 1 || size.height < 1 || size.width > IMAGE_DIM_MAX || size.height > IMAGE_DIM_MAX) return { ok: false, reason: 'dimensions' };
    return { ok: true, ext: TYPES[type].ext, mime: TYPES[type].mime, width: size.width, height: size.height };
  } catch (_error) {
    return { ok: false, reason: 'unsupported' };
  }
}

module.exports = { IMAGE_DIM_MAX, MIME_BY_EXT, imageInfo };
