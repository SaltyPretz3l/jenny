'use strict';

// Row 142 S3: unpacks one llama.cpp release zip into a staging folder that
// llama-server-runtime-download.js created, after the zip's sha256 already
// matched the catalog. These checks are defence in depth, copied in kind from
// services/pdf-addon-wheel.js: every entry name is a plain relative POSIX path
// (no absolute name, drive letter, `..`, backslash, NUL, control or reserved
// segment), links and special files are refused, each file is created with
// `wx` under a parent whose real path is inside the staging folder, and the
// bytes written are bounded by a budget shared across the zips of one build.
// Failures throw an error carrying only a reason code: `unsafe_entry`,
// `too_large`, `no_space` or `cancelled`.

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const yauzl = require('yauzl');

const MAX_ENTRIES = 4096;
const WINDOWS_RESERVED_SEGMENT = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const UNSAFE_SEGMENT_CHARS = /[\u0000-\u001f<>:"|?*\\]/;
const DOS_REPARSE_POINT = 0x0400;
const UNIX_HOST = 3;
const UNIX_TYPE_MASK = 0xf000;
const UNIX_REGULAR = 0x8000;
const UNIX_DIRECTORY = 0x4000;

function extractError(reason) {
  return Object.assign(new Error(reason), { reason });
}

function safeSegments(fileName) {
  const trimmed = fileName.endsWith('/') ? fileName.slice(0, -1) : fileName;
  const segments = trimmed.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..'
      || UNSAFE_SEGMENT_CHARS.test(segment)
      || WINDOWS_RESERVED_SEGMENT.test(segment)
      || /[. ]$/.test(segment)) {
      throw extractError('unsafe_entry');
    }
  }
  return segments;
}

function assertPlainEntry(entry) {
  if (entry.isEncrypted()) throw extractError('unsafe_entry');
  const attributes = entry.externalFileAttributes >>> 0;
  if ((attributes & DOS_REPARSE_POINT) !== 0) throw extractError('unsafe_entry');
  if ((entry.versionMadeBy >>> 8) === UNIX_HOST) {
    const type = (attributes >>> 16) & UNIX_TYPE_MASK;
    if (type !== 0 && type !== UNIX_REGULAR && type !== UNIX_DIRECTORY) throw extractError('unsafe_entry');
  }
}

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, {
      lazyEntries: true, autoClose: true, strictFileNames: true, validateEntrySizes: true,
    }, (error, zipfile) => (error ? reject(error) : resolve(zipfile)));
  });
}

function openEntryStream(zipfile, entry) {
  return new Promise((resolve, reject) => {
    zipfile.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream)));
  });
}

const inside = (root, target, platform) => {
  const key = (value) => (platform === 'win32' ? value.toLowerCase() : value);
  const relative = path.relative(key(root), key(target));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

// Maps whatever a zip or the disk throws to a reason code (no raw text leaves).
function reasonOf(error) {
  const reason = String(error?.reason || '');
  if (/^[a-z][a-z0-9_]{0,39}$/.test(reason)) return reason;
  if (error?.code === 'ENOSPC') return 'no_space';
  return 'unsafe_entry';
}

// budget: { remaining } shared by every zip of one build. Resolves { fileCount }.
async function extractRuntimeZip({
  zipPath, destDir, budget, signal = null, fsImpl = fs, platform = process.platform,
}) {
  const root = path.resolve(destDir);
  const fsp = fsImpl.promises;
  const realRoot = await fsp.realpath(root);
  const parents = new Set();
  const confinedParent = async (dir) => {
    if (parents.has(dir)) return;
    const real = await fsp.realpath(dir);
    if (!inside(realRoot, real, platform) && path.resolve(real) !== path.resolve(realRoot)) {
      throw extractError('unsafe_entry');
    }
    parents.add(dir);
  };
  let zipfile;
  try {
    zipfile = await openZip(zipPath);
  } catch (error) {
    throw extractError(reasonOf(error));
  }
  if (zipfile.entryCount > MAX_ENTRIES) {
    zipfile.close();
    throw extractError('unsafe_entry');
  }
  let fileCount = 0;
  try {
    await new Promise((resolve, reject) => {
      zipfile.on('error', reject);
      zipfile.on('end', resolve);
      zipfile.on('entry', (entry) => {
        (async () => {
          if (signal?.aborted) throw extractError('cancelled');
          const segments = safeSegments(entry.fileName);
          assertPlainEntry(entry);
          const target = path.join(root, ...segments);
          if (!inside(root, target, platform)) throw extractError('unsafe_entry');
          if (entry.fileName.endsWith('/')) {
            await fsp.mkdir(target, { recursive: true });
            await confinedParent(target);
            return;
          }
          budget.remaining -= entry.uncompressedSize;
          if (budget.remaining < 0) throw extractError('too_large');
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await confinedParent(path.dirname(target));
          const source = await openEntryStream(zipfile, entry);
          await pipeline(source, fsImpl.createWriteStream(target, { flags: 'wx' }));
          fileCount += 1;
        })().then(() => zipfile.readEntry(), reject);
      });
      zipfile.readEntry();
    });
  } catch (error) {
    throw extractError(reasonOf(error));
  } finally {
    zipfile.close();
  }
  return { fileCount };
}

module.exports = { extractRuntimeZip, safeSegments };
