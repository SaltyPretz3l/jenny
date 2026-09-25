'use strict';

/**
 * services/pdf-addon-wheel.js
 *
 * Streams a Python wheel (a ZIP) into an empty directory. The PDF add-on only
 * extracts a wheel whose sha256 already matched the pin, so these checks are
 * defence in depth, not the trust decision:
 *  - entry names must be relative POSIX paths with no `..`, `.`, empty,
 *    drive-letter, backslash, control-character or Windows-reserved segment,
 *    and must resolve inside the destination;
 *  - links, reparse points, special files and encrypted entries are refused;
 *  - entry count, per-entry size and total size are capped (PyMuPDF 1.27.2.2
 *    is 115 entries, 48 MB, largest file 25.6 MB), and yauzl checks each
 *    entry's real size against its declared size;
 *  - files are created with `wx`, so a duplicate (including a case-folded
 *    duplicate on Windows) fails instead of overwriting.
 * The plugin reader (services/plugins/package/zip-package-reader.js) is not
 * reused: it buffers entries in memory with 4 MiB caps and rejects directory
 * entries, which real wheels carry.
 */

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const yauzl = require('yauzl');
const LIMITS = Object.freeze({
  maxEntries: 4096,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 256 * 1024 * 1024,
});

const WINDOWS_RESERVED_SEGMENT = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const UNSAFE_SEGMENT_CHARS = /[\u0000-\u001f<>:"|?*\\]/;
const DOS_REPARSE_POINT = 0x0400;
const UNIX_HOST = 3;
const UNIX_TYPE_MASK = 0xf000;
const UNIX_REGULAR = 0x8000;
const UNIX_DIRECTORY = 0x4000;

function wheelError(message) {
  const error = new Error(message);
  error.code = 'wheel_invalid';
  return error;
}

function safeSegments(fileName) {
  const trimmed = fileName.endsWith('/') ? fileName.slice(0, -1) : fileName;
  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..'
      || UNSAFE_SEGMENT_CHARS.test(segment)
      || WINDOWS_RESERVED_SEGMENT.test(segment)
      || /[. ]$/.test(segment)) {
      throw wheelError(`Unsafe wheel entry name: ${JSON.stringify(fileName).slice(0, 200)}`);
    }
  }
  return segments;
}

function assertPlainEntry(entry) {
  if (entry.isEncrypted()) throw wheelError('Encrypted wheel entries are not allowed.');
  const attributes = entry.externalFileAttributes >>> 0;
  if ((attributes & DOS_REPARSE_POINT) !== 0) throw wheelError('Links are not allowed in the wheel.');
  if ((entry.versionMadeBy >>> 8) === UNIX_HOST) {
    const type = (attributes >>> 16) & UNIX_TYPE_MASK;
    if (type !== 0 && type !== UNIX_REGULAR && type !== UNIX_DIRECTORY) {
      throw wheelError('Links and special files are not allowed in the wheel.');
    }
  }
}

function openZip(wheelPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(wheelPath, {
      lazyEntries: true,
      autoClose: true,
      strictFileNames: true,
      validateEntrySizes: true,
    }, (error, zipfile) => (error ? reject(error) : resolve(zipfile)));
  });
}

function openEntryStream(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream)));
  });
}

async function extractWheel({ wheelPath, destDir, limits = LIMITS, fsImpl = fs }) {
  const root = path.resolve(destDir);
  const zipfile = await openZip(wheelPath);
  if (zipfile.entryCount > limits.maxEntries) {
    zipfile.close();
    throw wheelError('The wheel has too many entries.');
  }
  let totalBytes = 0;
  let fileCount = 0;
  try {
    await new Promise((resolve, reject) => {
      zipfile.on('error', reject);
      zipfile.on('end', resolve);
      zipfile.on('entry', (entry) => {
        (async () => {
          const segments = safeSegments(entry.fileName);
          assertPlainEntry(entry);
          const target = path.join(root, ...segments);
          const relative = path.relative(root, target);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            throw wheelError('A wheel entry resolves outside the install directory.');
          }
          if (entry.fileName.endsWith('/')) {
            await fsImpl.promises.mkdir(target, { recursive: true });
            return;
          }
          if (entry.uncompressedSize > limits.maxEntryUncompressedBytes) {
            throw wheelError('A wheel entry is larger than allowed.');
          }
          totalBytes += entry.uncompressedSize;
          if (totalBytes > limits.maxTotalUncompressedBytes) {
            throw wheelError('The wheel expands to more than allowed.');
          }
          await fsImpl.promises.mkdir(path.dirname(target), { recursive: true });
          const source = await openEntryStream(zipfile, entry);
          await pipeline(source, fsImpl.createWriteStream(target, { flags: 'wx' }));
          fileCount += 1;
        })().then(() => zipfile.readEntry(), reject);
      });
      zipfile.readEntry();
    });
  } finally {
    zipfile.close();
  }
  return { fileCount, totalBytes };
}

module.exports = { extractWheel };
