'use strict';

// Hand-assembled ZIP byte primitives for hostile-archive test fixtures.
//
// PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md's supply-chain section requires
// Jenny's archive validator to reject a long list of hostile ZIP shapes
// before materialization (path traversal, header disagreement, CRC/size
// mismatch, polyglot trailers, ...). Committing hand-crafted malicious ZIP
// *binaries* to the repo is a bad idea twice over: they get quarantined by
// antivirus/Defender on checkout, and their bytes are unreviewable in a diff.
// Instead, this helper builds the exact bytes at test time from a plain
// JS description of each entry, so the hostile shapes are fully visible as
// ordinary source code.
//
// This module writes ONLY in-memory Buffers: no fs, no net, no compression
// library. Every entry is stored (method 0, uncompressed), which is all a
// hostile-fixture builder needs.
//
// ZIP layout produced: [local file headers + data]... [central directory
// headers]... [end of central directory record] [optional trailing bytes].
// Field layouts follow the PKWARE APPNOTE local/central/EOCD record shapes.

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;

const LOCAL_FILE_HEADER_FIXED_SIZE = 30;
const CENTRAL_DIRECTORY_HEADER_FIXED_SIZE = 46;
const END_OF_CENTRAL_DIRECTORY_FIXED_SIZE = 22;

// Fixed MS-DOS date/time fields (arbitrary but valid: 2020-01-01 00:00:00).
// Test fixtures never depend on entry timestamps.
const FIXED_DOS_TIME = 0x0000;
const FIXED_DOS_DATE = 0x0021;

// --- CRC-32 (IEEE 802.3), computed with the standard reflected polynomial ---
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * @param {Buffer} buffer
 * @returns {number} unsigned 32-bit CRC-32 of `buffer`.
 */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * One ZIP entry description.
 * @typedef {{
 *   name: string,
 *   data?: Buffer,
 *   generalPurposeBitFlag?: number,
 *   externalAttributes?: number,
 *   crc32Override?: number,
 *   compressedSizeOverride?: number,
 *   uncompressedSizeOverride?: number,
 *   centralOverrides?: {name?:string, crc32?:number, compressedSize?:number, uncompressedSize?:number},
 * }} HostileEntrySpec
 */

/**
 * @param {HostileEntrySpec} spec
 */
function resolvedCrc32(spec) {
  return spec.crc32Override !== undefined ? spec.crc32Override >>> 0 : crc32(spec.data || Buffer.alloc(0));
}

/**
 * @param {HostileEntrySpec} spec
 */
function resolvedCompressedSize(spec) {
  return spec.compressedSizeOverride !== undefined
    ? spec.compressedSizeOverride >>> 0
    : (spec.data || Buffer.alloc(0)).length;
}

/**
 * @param {HostileEntrySpec} spec
 */
function resolvedUncompressedSize(spec) {
  return spec.uncompressedSizeOverride !== undefined
    ? spec.uncompressedSizeOverride >>> 0
    : (spec.data || Buffer.alloc(0)).length;
}

/**
 * @param {HostileEntrySpec} spec
 * @returns {Buffer} the local file header + entry data.
 */
function buildLocalFileHeader(spec) {
  const nameBytes = Buffer.from(spec.name, 'utf8');
  const data = spec.data || Buffer.alloc(0);
  const header = Buffer.alloc(LOCAL_FILE_HEADER_FIXED_SIZE);
  header.writeUInt32LE(LOCAL_FILE_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(20, 4); // version needed to extract
  header.writeUInt16LE(spec.generalPurposeBitFlag || 0, 6);
  header.writeUInt16LE(0, 8); // compression method: stored
  header.writeUInt16LE(FIXED_DOS_TIME, 10);
  header.writeUInt16LE(FIXED_DOS_DATE, 12);
  header.writeUInt32LE(resolvedCrc32(spec), 14);
  header.writeUInt32LE(resolvedCompressedSize(spec), 18);
  header.writeUInt32LE(resolvedUncompressedSize(spec), 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28); // extra field length
  return Buffer.concat([header, nameBytes, data]);
}

/**
 * @param {HostileEntrySpec} spec
 * @param {number} localHeaderOffset
 * @returns {Buffer} the central directory header for `spec`.
 */
function buildCentralDirectoryHeader(spec, localHeaderOffset) {
  const overrides = spec.centralOverrides || {};
  const name = overrides.name !== undefined ? overrides.name : spec.name;
  const nameBytes = Buffer.from(name, 'utf8');
  const crc = overrides.crc32 !== undefined ? overrides.crc32 >>> 0 : resolvedCrc32(spec);
  const compSize = overrides.compressedSize !== undefined ? overrides.compressedSize >>> 0 : resolvedCompressedSize(spec);
  const uncompSize = overrides.uncompressedSize !== undefined
    ? overrides.uncompressedSize >>> 0
    : resolvedUncompressedSize(spec);

  const header = Buffer.alloc(CENTRAL_DIRECTORY_HEADER_FIXED_SIZE);
  header.writeUInt32LE(CENTRAL_DIRECTORY_SIGNATURE, 0);
  header.writeUInt16LE(20, 4); // version made by
  header.writeUInt16LE(20, 6); // version needed to extract
  header.writeUInt16LE(spec.generalPurposeBitFlag || 0, 8);
  header.writeUInt16LE(0, 10); // compression method: stored
  header.writeUInt16LE(FIXED_DOS_TIME, 12);
  header.writeUInt16LE(FIXED_DOS_DATE, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compSize, 20);
  header.writeUInt32LE(uncompSize, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30); // extra field length
  header.writeUInt16LE(0, 32); // file comment length
  header.writeUInt16LE(0, 34); // disk number start
  header.writeUInt16LE(0, 36); // internal file attributes
  header.writeUInt32LE(spec.externalAttributes || 0, 38);
  header.writeUInt32LE(localHeaderOffset >>> 0, 42);
  return Buffer.concat([header, nameBytes]);
}

/**
 * @param {{entryCount:number,centralDirSize:number,centralDirOffset:number,comment?:Buffer}} args
 */
function buildEndOfCentralDirectory({ entryCount, centralDirSize, centralDirOffset, comment }) {
  const commentBytes = comment || Buffer.alloc(0);
  const record = Buffer.alloc(END_OF_CENTRAL_DIRECTORY_FIXED_SIZE);
  record.writeUInt32LE(END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  record.writeUInt16LE(0, 4); // disk number
  record.writeUInt16LE(0, 6); // disk with central directory
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(centralDirSize >>> 0, 12);
  record.writeUInt32LE(centralDirOffset >>> 0, 16);
  record.writeUInt16LE(commentBytes.length, 20);
  return Buffer.concat([record, commentBytes]);
}

/**
 * Assembles a complete ZIP byte buffer from entry specs.
 * @param {HostileEntrySpec[]} entrySpecs
 * @param {{trailingBytes?: Buffer}} [options]
 * @returns {{bytes: Buffer, localHeaderOffsets: number[]}}
 */
function assembleZip(entrySpecs, options = {}) {
  let offset = 0;
  const localBuffers = [];
  const localHeaderOffsets = [];
  const centralBuffers = [];

  for (const spec of entrySpecs) {
    localHeaderOffsets.push(offset);
    const localBuf = buildLocalFileHeader(spec);
    localBuffers.push(localBuf);
    centralBuffers.push(buildCentralDirectoryHeader(spec, offset));
    offset += localBuf.length;
  }

  const centralDirOffset = offset;
  const centralDir = Buffer.concat(centralBuffers);
  const eocd = buildEndOfCentralDirectory({
    entryCount: entrySpecs.length,
    centralDirSize: centralDir.length,
    centralDirOffset,
  });

  const parts = [...localBuffers, centralDir, eocd];
  if (options.trailingBytes) parts.push(options.trailingBytes);
  return { bytes: Buffer.concat(parts), localHeaderOffsets };
}

/**
 * Reads back a local file header at `offset`, for test-side structural
 * assertions (e.g. proving a CRC/size mismatch is really encoded in the
 * bytes, not just in the spec object used to build them).
 * @param {Buffer} buffer
 * @param {number} offset
 */
function readLocalFileHeader(buffer, offset) {
  const nameLength = buffer.readUInt16LE(offset + 26);
  return {
    signature: buffer.readUInt32LE(offset),
    generalPurposeBitFlag: buffer.readUInt16LE(offset + 6),
    crc32: buffer.readUInt32LE(offset + 14),
    compressedSize: buffer.readUInt32LE(offset + 18),
    uncompressedSize: buffer.readUInt32LE(offset + 22),
    nameLength,
    name: buffer.toString('utf8', offset + LOCAL_FILE_HEADER_FIXED_SIZE, offset + LOCAL_FILE_HEADER_FIXED_SIZE + nameLength),
    dataStart: offset + LOCAL_FILE_HEADER_FIXED_SIZE + nameLength,
  };
}

/**
 * Reads back a central directory header at `offset` (see readLocalFileHeader).
 * @param {Buffer} buffer
 * @param {number} offset
 */
function readCentralDirectoryHeader(buffer, offset) {
  const nameLength = buffer.readUInt16LE(offset + 28);
  return {
    signature: buffer.readUInt32LE(offset),
    generalPurposeBitFlag: buffer.readUInt16LE(offset + 8),
    crc32: buffer.readUInt32LE(offset + 16),
    compressedSize: buffer.readUInt32LE(offset + 20),
    uncompressedSize: buffer.readUInt32LE(offset + 24),
    nameLength,
    externalAttributes: buffer.readUInt32LE(offset + 38),
    localHeaderOffset: buffer.readUInt32LE(offset + 42),
    name: buffer.toString('utf8', offset + CENTRAL_DIRECTORY_HEADER_FIXED_SIZE, offset + CENTRAL_DIRECTORY_HEADER_FIXED_SIZE + nameLength),
  };
}

module.exports = {
  LOCAL_FILE_HEADER_FIXED_SIZE,
  CENTRAL_DIRECTORY_HEADER_FIXED_SIZE,
  END_OF_CENTRAL_DIRECTORY_FIXED_SIZE,
  crc32,
  buildLocalFileHeader,
  buildCentralDirectoryHeader,
  buildEndOfCentralDirectory,
  assembleZip,
  readLocalFileHeader,
  readCentralDirectoryHeader,
};
