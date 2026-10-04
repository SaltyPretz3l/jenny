// Structural PNG gate for plugin-generated artifact publication.
//
// This is a security boundary rather than a policy check: a trusted native
// plugin host hands core a scratch-file path, and everything downstream (the
// asset store, transcript row, lightbox, export) treats a published file as a
// real image. A shallow check validates the signature, a CRC-correct IHDR, and a
// trailing IEND - which a 45-byte header-only file satisfies with no pixel data
// at all, and which a PNG polyglot satisfies with an arbitrary payload appended
// after IEND.
//
// The gate is deliberately pure JS + Node's built-in zlib. An Electron
// `nativeImage` decode would be a stronger oracle but would drag the main
// process's GPU-backed image stack into a unit-testable module and make this
// unrunnable outside Electron; the owner's call (2026-07-31) is structural
// checks plus a real inflate. Unlike publishGeneratedPreview - which is
// fail-soft because a missing preview is cosmetic - every path here fails
// closed: an image we cannot fully account for is not ingested.

const zlib = require('zlib');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR_CHUNK_LENGTH = 13;
// 4 length + 4 type + 4 CRC around every chunk's payload.
const PNG_CHUNK_OVERHEAD = 12;
const PNG_CHUNK_TYPE_RE = /^[A-Za-z]{4}$/;

// Channels per colour type, and the bit depths PNG actually allows with each
// (spec 11.2.2). An out-of-table pair is not a legal PNG, so the scanline size
// below would be meaningless - reject rather than guess.
const COLOR_TYPE_CHANNELS = Object.freeze({
  0: 1, 2: 3, 3: 1, 4: 2, 6: 4,
});
const COLOR_TYPE_BIT_DEPTHS = Object.freeze({
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
});

// Hard bound on the inflate, checked from the DECLARED dimensions before any
// decompression runs. Without it a 30000x30000 grayscale-16 header - a few
// kilobytes of deflated zeros - would ask Node to materialize ~1.8 GB. The
// largest C6 preset at the widest legal format (3104x1312, 16-bit RGBA) needs
// ~32.6 MB, so 64 MB clears every image this pipeline can legitimately produce.
const MAX_DECOMPRESSED_IMAGE_BYTES = 64 * 1024 * 1024;

let CRC32_TABLE = null;

function crc32(buffer) {
  if (!CRC32_TABLE) {
    CRC32_TABLE = new Int32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      CRC32_TABLE[index] = value;
    }
  }
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function refuse(reason) {
  return { ok: false, reason };
}

function readIhdr(buffer, offset) {
  const width = buffer.readUInt32BE(offset);
  const height = buffer.readUInt32BE(offset + 4);
  const bitDepth = buffer.readUInt8(offset + 8);
  const colorType = buffer.readUInt8(offset + 9);
  const compression = buffer.readUInt8(offset + 10);
  const filterMethod = buffer.readUInt8(offset + 11);
  const interlace = buffer.readUInt8(offset + 12);
  const allowedDepths = COLOR_TYPE_BIT_DEPTHS[colorType];
  if (width <= 0 || height <= 0 || !allowedDepths || !allowedDepths.includes(bitDepth)) {
    return null;
  }
  // Only deflate/adaptive-filter/non-interlaced is defined by the spec, and
  // Adam7 interlacing (interlace 1) would make the scanline arithmetic below
  // wrong rather than merely unsupported. The worker writes progressive-free
  // PNGs, so anything else is fail-closed.
  if (compression !== 0 || filterMethod !== 0 || interlace !== 0) {
    return null;
  }
  return { width, height, bitDepth, colorType };
}

/** Row size including the per-scanline filter byte (spec 7.2 / 9.2). */
function expectedRawSize({ width, height, bitDepth, colorType }) {
  const channels = COLOR_TYPE_CHANNELS[colorType];
  const bytesPerRow = Math.ceil((width * channels * bitDepth) / 8);
  return height * (1 + bytesPerRow);
}

/**
 * Walk the chunk sequence once and account for every byte in the buffer.
 *
 * Requires, in order: the 8-byte signature; IHDR first with a legal
 * bitDepth/colourType pair; every chunk's CRC32 verifying; at least one IDAT
 * with a non-zero total payload; IDAT chunks contiguous; IEND last; and
 * `8 + sum(12 + length)` exactly equal to the buffer length, so nothing may be
 * appended after IEND (the polyglot case the old trailing-IEND string check
 * missed). Then inflates the concatenated IDAT payloads and requires the
 * decompressed length to equal the scanline size the IHDR declares.
 *
 * Returns `{ ok: true, width, height, bitDepth, colorType, idatBytes,
 * rawBytes }` or `{ ok: false, reason }` with a bounded reason string.
 */
function readPngStructure(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length) {
    return refuse('not_png');
  }
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return refuse('not_png');
  }
  let offset = PNG_SIGNATURE.length;
  let header = null;
  let sawIend = false;
  let idatClosed = false;
  const idatParts = [];
  let idatBytes = 0;

  while (offset < buffer.length) {
    if (buffer.length - offset < PNG_CHUNK_OVERHEAD) {
      return refuse('not_png');
    }
    const length = buffer.readUInt32BE(offset);
    // The spec caps a chunk at 2^31-1; a larger declared length is either a
    // corrupt stream or an attempt to wrap the offset arithmetic.
    if (length > 0x7fffffff || buffer.length - offset - PNG_CHUNK_OVERHEAD < length) {
      return refuse('not_png');
    }
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (!PNG_CHUNK_TYPE_RE.test(type)) {
      return refuse('not_png');
    }
    const declaredCrc = buffer.readUInt32BE(offset + 8 + length);
    if (declaredCrc !== crc32(buffer.subarray(offset + 4, offset + 8 + length))) {
      return refuse('crc_mismatch');
    }
    if (header === null) {
      if (type !== 'IHDR') {
        return refuse('chunk_order');
      }
      if (length !== PNG_IHDR_CHUNK_LENGTH) {
        return refuse('bad_ihdr');
      }
      header = readIhdr(buffer, offset + 8);
      if (!header) {
        return refuse('bad_ihdr');
      }
    } else if (type === 'IHDR') {
      return refuse('chunk_order');
    }
    if (type === 'IDAT') {
      // Contiguity matters: a decoder concatenates IDATs in stream order, so a
      // split run means some other chunk's bytes sit inside the image data.
      if (idatClosed) {
        return refuse('chunk_order');
      }
      idatParts.push(buffer.subarray(offset + 8, offset + 8 + length));
      idatBytes += length;
    } else if (idatParts.length) {
      idatClosed = true;
    }
    offset += PNG_CHUNK_OVERHEAD + length;
    if (type === 'IEND') {
      if (length !== 0) {
        return refuse('chunk_order');
      }
      sawIend = true;
      break;
    }
  }

  if (!header || !sawIend) {
    return refuse('chunk_order');
  }
  // Every byte accounted for: no payload smuggled after IEND.
  if (offset !== buffer.length) {
    return refuse('trailing_bytes');
  }
  if (!idatParts.length || idatBytes <= 0) {
    return refuse('no_idat');
  }

  const rawBytes = expectedRawSize(header);
  if (!Number.isFinite(rawBytes) || rawBytes <= 0 || rawBytes > MAX_DECOMPRESSED_IMAGE_BYTES) {
    return refuse('idat_size_mismatch');
  }
  let inflated;
  try {
    // maxOutputLength turns a zip-bomb into a cheap throw instead of an
    // allocation: anything past the declared scanline size is already a
    // mismatch, so there is no reason to materialize it.
    inflated = zlib.inflateSync(Buffer.concat(idatParts), { maxOutputLength: rawBytes + 1 });
  } catch (error) {
    return refuse(
      String((error && error.code) || '') === 'ERR_BUFFER_TOO_LARGE'
        ? 'idat_size_mismatch'
        : 'idat_inflate_failed'
    );
  }
  if (inflated.length !== rawBytes) {
    return refuse('idat_size_mismatch');
  }
  const rowStride = rawBytes / header.height;
  for (let offset = 0; offset < inflated.length; offset += rowStride) {
    if (inflated[offset] > 4) return refuse('invalid_filter_type');
  }
  return { ok: true, ...header, idatBytes, rawBytes };
}

module.exports = {
  PNG_SIGNATURE,
  crc32,
  readPngStructure,
};
