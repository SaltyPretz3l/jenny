'use strict';

const crypto = require('node:crypto');
const yauzl = require('yauzl');

const { validateZipStructure } = require('./zip-structure-validator');

const DEFAULT_MAX_CAPTURED_ENTRY_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_CAPTURED_BYTES = 16 * 1024 * 1024;

const CRC32_TABLE = Object.freeze(Array.from({ length: 256 }, (_unused, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
}));

function crc32Update(state, chunk) {
  let next = state >>> 0;
  for (const byte of chunk) {
    next = (CRC32_TABLE[(next ^ byte) & 0xff] ^ (next >>> 8)) >>> 0;
  }
  return next;
}

function fail(reason, detail = null) {
  return { ok: false, reason, detail };
}

function openZip(bytes) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, {
      lazyEntries: true,
      autoClose: true,
      decodeStrings: false,
      validateEntrySizes: true,
    }, (error, zipfile) => {
      if (error) reject(error);
      else resolve(zipfile);
    });
  });
}

function readEntryStream(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

async function digestEntry(zipfile, entry, structureEntry, captureLimit) {
  const stream = await readEntryStream(zipfile, entry);
  const hash = crypto.createHash('sha256');
  const chunks = [];
  let capturedBytes = 0;
  let capturing = captureLimit !== null;
  let actualBytes = 0;
  let crcState = 0xffffffff;

  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => {
      actualBytes += chunk.length;
      if (actualBytes > structureEntry.uncompressedSize) {
        stream.destroy(new Error('entry_expanded_beyond_declared_size'));
        return;
      }
      hash.update(chunk);
      crcState = crc32Update(crcState, chunk);
      if (capturing && capturedBytes + chunk.length <= captureLimit) {
        chunks.push(Buffer.from(chunk));
        capturedBytes += chunk.length;
      } else if (capturing) {
        chunks.length = 0;
        capturedBytes = 0;
        capturing = false;
      }
    });
    stream.once('error', reject);
    stream.once('end', () => {
      const actualCrc32 = (crcState ^ 0xffffffff) >>> 0;
      if (actualBytes !== structureEntry.uncompressedSize) {
        resolve(fail('uncompressed_size_mismatch', { index: structureEntry.index }));
        return;
      }
      if (actualCrc32 !== structureEntry.crc32) {
        resolve(fail('crc32_mismatch', { index: structureEntry.index }));
        return;
      }
      resolve({
        ok: true,
        sha256: hash.digest('hex'),
        bytes: capturing ? Buffer.concat(chunks, actualBytes) : null,
        actualBytes,
        crc32: actualCrc32,
      });
    });
  });
}

function normalizeCapturePaths(capturePaths) {
  if (capturePaths === undefined || capturePaths === null) return new Set();
  if (!Array.isArray(capturePaths) && !(capturePaths instanceof Set)) return null;
  const normalized = new Set();
  for (const entryPath of capturePaths) {
    if (typeof entryPath !== 'string') return null;
    normalized.add(entryPath);
  }
  return normalized;
}

async function readZipPackage(bytes, {
  limits,
  capturePaths,
  maxCapturedEntryBytes = DEFAULT_MAX_CAPTURED_ENTRY_BYTES,
  maxTotalCapturedBytes = DEFAULT_MAX_TOTAL_CAPTURED_BYTES,
  digestUncaptured = true,
} = {}) {
  const structure = validateZipStructure(bytes, { limits });
  if (!structure.ok) return structure;
  const selectedPaths = normalizeCapturePaths(capturePaths);
  if (
    selectedPaths === null
    || !Number.isSafeInteger(maxCapturedEntryBytes)
    || maxCapturedEntryBytes < 0
    || !Number.isSafeInteger(maxTotalCapturedBytes)
    || maxTotalCapturedBytes < 0
    || typeof digestUncaptured !== 'boolean'
  ) {
    return fail('invalid_capture_budget');
  }

  let zipfile;
  try {
    zipfile = await openZip(bytes);
  } catch (_error) {
    return fail('zip_parser_rejected_archive');
  }

  const digests = new Map();
  const bytesByPath = new Map();
  const observedEntries = [];
  let totalCapturedBytes = 0;

  return new Promise((resolve) => {
    let settled = false;
    let index = 0;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { zipfile.close(); } catch (_error) { /* already closed */ }
      resolve(result);
    };

    zipfile.once('error', () => finish(fail('zip_stream_error')));
    zipfile.once('end', () => {
      if (index !== structure.entries.length) {
        finish(fail('zip_entry_count_mismatch'));
        return;
      }
      finish({
        ok: true,
        entries: observedEntries,
        digests,
        bytesByPath,
        archiveDigest: crypto.createHash('sha256').update(bytes).digest('hex'),
        archiveBytes: bytes.length,
        entryCount: structure.entries.length,
        totalUncompressedBytes: structure.totalUncompressedBytes,
        totalCapturedBytes,
        digestOf: async (entryPath) => digests.get(entryPath) || null,
        bytesOf: (entryPath) => bytesByPath.get(entryPath) || null,
      });
    });
    zipfile.on('entry', async (entry) => {
      const expected = structure.entries[index];
      if (!expected || !Buffer.isBuffer(entry.fileName) || !entry.fileName.equals(expected.rawName)) {
        finish(fail('zip_entry_order_or_name_mismatch', { index }));
        return;
      }
      if (
        entry.compressionMethod !== expected.compressionMethod
        || entry.compressedSize !== expected.compressedSize
        || entry.uncompressedSize !== expected.uncompressedSize
        || entry.crc32 !== expected.crc32
      ) {
        finish(fail('zip_parser_metadata_mismatch', { index }));
        return;
      }
      let measured;
      const selected = selectedPaths.has(expected.path);
      if (!selected && !digestUncaptured) {
        observedEntries.push({
          path: expected.path,
          compressedSize: expected.compressedSize,
          uncompressedSize: expected.uncompressedSize,
          compressionMethod: expected.compressionMethod,
          isDirectory: false,
          isSymlink: false,
          isHardLink: false,
          isEncrypted: false,
        });
        index += 1;
        if (!settled) zipfile.readEntry();
        return;
      }
      const remainingCaptureBytes = Math.max(0, maxTotalCapturedBytes - totalCapturedBytes);
      const entryCaptureLimit = selected
        && expected.uncompressedSize <= maxCapturedEntryBytes
        && expected.uncompressedSize <= remainingCaptureBytes
        ? Math.min(maxCapturedEntryBytes, remainingCaptureBytes)
        : null;
      try {
        measured = await digestEntry(zipfile, entry, expected, entryCaptureLimit);
      } catch (_error) {
        finish(fail('entry_stream_failed', { index }));
        return;
      }
      if (!measured.ok) {
        finish(measured);
        return;
      }
      digests.set(expected.path, measured.sha256);
      if (measured.bytes !== null) {
        bytesByPath.set(expected.path, measured.bytes);
        totalCapturedBytes += measured.bytes.length;
      }
      observedEntries.push({
        path: expected.path,
        compressedSize: expected.compressedSize,
        uncompressedSize: expected.uncompressedSize,
        compressionMethod: expected.compressionMethod,
        isDirectory: false,
        isSymlink: false,
        isHardLink: false,
        isEncrypted: false,
      });
      index += 1;
      if (!settled) {
        zipfile.readEntry();
      }
    });
    zipfile.readEntry();
  });
}

module.exports = {
  DEFAULT_MAX_CAPTURED_ENTRY_BYTES,
  DEFAULT_MAX_TOTAL_CAPTURED_BYTES,
  crc32Update,
  normalizeCapturePaths,
  readZipPackage,
};
