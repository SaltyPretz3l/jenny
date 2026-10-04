'use strict';

// Per-entry archive writers: copy or encrypt one source with a digest, retrying
// once if the source changes underneath (split from archive-service.js).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { DATA_ERROR_CODES } = require('../backend/error-codes');
const { archiveError, encryptBuffer, encryptFile } = require('./archive-format');

function sourceSnapshot(sourcePath) {
  let stat;
  try {
    stat = fs.lstatSync(sourcePath);
  } catch (error) {
    throw archiveError(DATA_ERROR_CODES.SOURCE_UNREADABLE, 'source_unreadable', 'Archive source is unreadable.', error);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw archiveError(DATA_ERROR_CODES.SOURCE_UNREADABLE, 'source_unreadable', 'Archive source is not a regular file.');
  }
  return { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, dev: stat.dev, ino: stat.ino };
}

function snapshotsEqual(first, second) {
  return first.size === second.size
    && first.mtimeMs === second.mtimeMs
    && first.ctimeMs === second.ctimeMs
    && first.dev === second.dev
    && first.ino === second.ino;
}

async function copyFileWithDigest(sourcePath, destinationPath, signal) {
  const hash = crypto.createHash('sha256');
  const digesting = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  await pipeline(
    fs.createReadStream(sourcePath),
    digesting,
    fs.createWriteStream(destinationPath, { flags: 'wx' }),
    { signal }
  );
  return hash.digest('hex');
}

async function writeSourceEntry({ entry, destinationPath, encrypt, masterKey, salt, entryId, signal }) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = sourceSnapshot(entry.sourcePath);
    await fs.promises.rm(destinationPath, { force: true });
    const result = encrypt
      ? await encryptFile({ sourcePath: entry.sourcePath, destinationPath, masterKey, salt, entryId, signal })
      : { sha256: await copyFileWithDigest(entry.sourcePath, destinationPath, signal) };
    const after = sourceSnapshot(entry.sourcePath);
    if (snapshotsEqual(before, after)) {
      if (entry.expectedSha256 && result.sha256 !== entry.expectedSha256) {
        throw archiveError(
          DATA_ERROR_CODES.RESTORE_CONFLICT,
          'workspace_review_stale',
          'Workspace archive contents changed after review. Review the workspace scope again.'
        );
      }
      return { ...result, size: after.size };
    }
  }
  throw archiveError(
    DATA_ERROR_CODES.SOURCE_UNREADABLE,
    'source_changed',
    'A source file changed while Jenny was archiving it. No data was removed.'
  );
}

async function writeBufferEntry({ entry, destinationPath, encrypt, masterKey, salt, entryId }) {
  if (encrypt) {
    return {
      ...(await encryptBuffer({ data: entry.data, destinationPath, masterKey, salt, entryId })),
      size: entry.data.length,
    };
  }
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.promises.writeFile(destinationPath, entry.data, { flag: 'wx' });
  return {
    sha256: crypto.createHash('sha256').update(entry.data).digest('hex'),
    size: entry.data.length,
  };
}

async function removeEntryStaging(stagingDir, entryFailed) {
  try {
    await fs.promises.rm(stagingDir, { recursive: true, force: true });
  } catch (error) {
    // Preserve the entry failure; outer partial cleanup retries removal.
    if (!entryFailed) throw error;
  }
}

module.exports = {
  copyFileWithDigest,
  removeEntryStaging,
  sourceSnapshot,
  writeBufferEntry,
  writeSourceEntry,
};
