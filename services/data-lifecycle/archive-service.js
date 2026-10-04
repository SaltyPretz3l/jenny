'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Writable } = require('stream');
const { DATA_ERROR_CODES } = require('../backend/error-codes');

const {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  KDF_PROFILE,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  archiveError,
  decryptFileToPath,
  decryptFileToSink,
  decryptManifest,
  deriveMasterKey,
  encodeBase64,
  encryptManifest,
  resolveArchiveChild,
  validateCategory,
  validateLogicalPath,
  validateManifest,
  validatePassphrase,
} = require('./archive-format');
const {
  buildPartialPath,
  isPathInside,
  removeOrReportPartial,
  sweepAbandonedPartials,
} = require('./archive-partials');

const {
  copyFileWithDigest,
  removeEntryStaging,
  sourceSnapshot,
  writeBufferEntry,
  writeSourceEntry,
} = require('./archive-entry-writers');

const ARCHIVE_EXTENSION = '.jenny-archive';
const COMPLETE_MARKER = 'COMPLETE';
const MIN_FREE_SPACE_RESERVE = 256 * 1024 * 1024;
const MAX_ENVELOPE_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;

function sanitizeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function buildDefaultArchiveRoot(documentsPath) {
  return path.join(String(documentsPath || ''), 'Jenny Archives');
}

function buildArchiveName(date = new Date()) {
  return `Jenny Archive ${sanitizeTimestamp(date)}${ARCHIVE_EXTENSION}`;
}

function normalizeEntries(entries) {
  if (!Array.isArray(entries) || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw archiveError(DATA_ERROR_CODES.INVALID_REQUEST, 'invalid_entries', 'Archive entry list is invalid or too large.');
  }
  const seen = new Set();
  let totalBytes = 0;
  return entries.map((entry) => {
    const logicalPath = validateLogicalPath(entry?.logicalPath);
    const folded = logicalPath.normalize('NFC').toLocaleLowerCase('en-US');
    if (seen.has(folded)) {
      throw archiveError(DATA_ERROR_CODES.INVALID_REQUEST, 'duplicate_archive_path', 'Archive entry paths must be unique.');
    }
    seen.add(folded);
    const hasSource = typeof entry?.sourcePath === 'string' && entry.sourcePath.trim();
    const hasData = entry && Object.prototype.hasOwnProperty.call(entry, 'data');
    const hasProducer = typeof entry?.produce === 'function';
    if (Number(Boolean(hasSource)) + Number(Boolean(hasData)) + Number(hasProducer) !== 1) {
      throw archiveError(DATA_ERROR_CODES.INVALID_REQUEST, 'invalid_entry_source', 'Each archive entry needs one data source.');
    }
    const data = hasData
      ? (Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8'))
      : null;
    let sourceStat;
    try {
      sourceStat = data || hasProducer ? null : fs.lstatSync(entry.sourcePath);
    } catch (error) {
      throw archiveError(DATA_ERROR_CODES.SOURCE_UNREADABLE, 'source_unreadable', 'Archive source is unreadable.', error);
    }
    if (sourceStat && (!sourceStat.isFile() || sourceStat.isSymbolicLink())) {
      throw archiveError(DATA_ERROR_CODES.SOURCE_UNREADABLE, 'source_unreadable', 'Archive source is not a regular file.');
    }
    const size = data ? data.length : Number(hasProducer ? entry.size || 0 : sourceStat.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw archiveError(DATA_ERROR_CODES.INVALID_REQUEST, 'archive_size_limit', 'Archive input exceeds the supported size limit.');
    }
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_ARCHIVE_BYTES) {
      throw archiveError(DATA_ERROR_CODES.INVALID_REQUEST, 'archive_size_limit', 'Archive input exceeds the supported size limit.');
    }
    return {
      logicalPath,
      category: validateCategory(
        String(entry.category || 'user_data'),
        DATA_ERROR_CODES.INVALID_REQUEST,
        'invalid_category'
      ),
      sourcePath: hasSource ? path.resolve(entry.sourcePath) : '',
      data,
      produce: hasProducer ? entry.produce : null,
      size,
      expectedSha256: /^[a-f0-9]{64}$/.test(String(entry.expectedSha256 || ''))
        ? String(entry.expectedSha256)
        : '',
      restoreMetadata: normalizeRestoreMetadata(entry.restoreMetadata),
    };
  });
}

function normalizeRestoreMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const sessionId = String(value.session_id || '').trim();
  if (!sessionId) return null;
  if (sessionId.length > 160 || !/^[A-Za-z0-9._-]+$/.test(sessionId)) {
    throw archiveError(DATA_ERROR_CODES.INVALID_REQUEST, 'invalid_restore_metadata', 'Archive restore metadata is invalid.');
  }
  return { session_id: sessionId };
}

async function findExistingAncestor(targetPath) {
  let current = path.resolve(targetPath);
  while (current !== path.dirname(current)) {
    try {
      await fs.promises.access(current);
      return current;
    } catch (_error) {
      current = path.dirname(current);
    }
  }
  return current;
}

async function assertFreeSpace(destinationRoot, requiredBytes) {
  if (typeof fs.promises.statfs !== 'function') return;
  const ancestor = await findExistingAncestor(destinationRoot);
  const stats = await fs.promises.statfs(ancestor);
  const available = Number(stats.bavail) * Number(stats.bsize);
  const reserve = Math.max(MIN_FREE_SPACE_RESERVE, Math.ceil(requiredBytes * 0.05));
  if (Number.isFinite(available) && available < requiredBytes + reserve) {
    throw archiveError(
      DATA_ERROR_CODES.INSUFFICIENT_SPACE,
      'insufficient_space',
      'The selected destination does not have enough free space for this archive.'
    );
  }
}

const STAGING_PREFIX = '.inventory-';
const STALE_STAGING_AGE_MS = 60 * 60 * 1000;

// A staging directory only outlives its entry when the process died mid-archive.
async function prepareEntryStagingRoot(stagingRoot, encrypted, hasProducedEntries) {
  if (!String(stagingRoot || '').trim()) {
    if (encrypted && hasProducedEntries) throw new TypeError('An encrypted archive with produced entries requires stagingRoot.');
    return '';
  }
  const root = path.resolve(String(stagingRoot));
  await fs.promises.mkdir(root, { recursive: true });
  // A junction or symlink here would carry plaintext out of the profile.
  const rootStat = await fs.promises.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()
    || fs.realpathSync.native(root) !== path.join(fs.realpathSync.native(path.dirname(root)), path.basename(root))) {
    throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_archive_path', 'Archive staging escapes the profile.');
  }
  const now = Date.now();
  for (const dirent of await fs.promises.readdir(root, { withFileTypes: true })) {
    if (!dirent.isDirectory() || !dirent.name.startsWith(STAGING_PREFIX)) continue;
    const stalePath = path.join(root, dirent.name);
    try {
      if (now - (await fs.promises.lstat(stalePath)).mtimeMs >= STALE_STAGING_AGE_MS) {
        await fs.promises.rm(stalePath, { recursive: true, force: true });
      }
    } catch {
      // Retried by the next archive.
    }
  }
  return root;
}

function buildReadme(encrypted) {
  return [
    'Jenny data archive',
    '',
    encrypted
      ? 'This archive is encrypted. Reinstall Jenny and choose Restore archive to open it.'
      : 'This archive is readable without a password. Keep it somewhere private.',
    'Do not rename or edit files inside this directory.',
    'Knowledge folder registrations and the contents of those folders are not part of this archive and must be added again after a restore.',
    `Format version: ${ARCHIVE_FORMAT_VERSION}`,
    '',
  ].join(os.EOL);
}

async function createArchive({
  destinationRoot,
  entries,
  encrypted = true,
  passphrase = '',
  appVersion = '0.0.0',
  createdAt = new Date(),
  archiveName = '',
  onProgress = null,
  shouldCancel = null,
  signal = undefined,
  onCommit = null,
  stagingRoot = '',
} = {}) {
  const normalizedRoot = path.resolve(String(destinationRoot || ''));
  if (!String(destinationRoot || '').trim()) {
    throw archiveError(DATA_ERROR_CODES.INVALID_REQUEST, 'destination_required', 'Archive destination is required.');
  }
  if (encrypted) validatePassphrase(passphrase);
  const normalizedEntries = normalizeEntries(entries);
  let estimatedBytes = normalizedEntries.reduce((sum, entry) => sum + entry.size, 0);
  await assertFreeSpace(normalizedRoot, estimatedBytes);
  await fs.promises.mkdir(normalizedRoot, { recursive: true });

  const finalName = archiveName || buildArchiveName(createdAt);
  if (!finalName.endsWith(ARCHIVE_EXTENSION) || path.basename(finalName) !== finalName) {
    throw archiveError(DATA_ERROR_CODES.INVALID_REQUEST, 'invalid_archive_name', 'Archive name is invalid.');
  }
  const finalPath = path.join(normalizedRoot, finalName);
  const partialPath = buildPartialPath(finalPath);
  if (!isPathInside(normalizedRoot, finalPath) || !isPathInside(normalizedRoot, partialPath)) {
    throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_archive_path', 'Archive destination is unsafe.');
  }
  if (fs.existsSync(finalPath)) {
    throw archiveError(DATA_ERROR_CODES.INVALID_REQUEST, 'archive_exists', 'An archive already exists at the selected destination.');
  }

  await sweepAbandonedPartials(normalizedRoot, { archiveExtension: ARCHIVE_EXTENSION });
  // Produced entries are plaintext (session exports, database snapshots), so an
  // encrypted archive stages them in the profile, never next to the archive.
  const entryStagingRoot = await prepareEntryStagingRoot(
    stagingRoot,
    encrypted,
    normalizedEntries.some((entry) => entry.produce)
  );

  const salt = encrypted ? crypto.randomBytes(32) : null;
  const masterKey = encrypted ? await deriveMasterKey(passphrase, salt, KDF_PROFILE) : null;
  const manifestEntries = [];
  let completedBytes = 0;
  const notify = (phase, label) => {
    if (typeof onProgress !== 'function') return;
    onProgress({
      phase,
      completedBytes,
      totalBytes: estimatedBytes,
      percent: estimatedBytes > 0 ? Math.min(100, Math.round((completedBytes / estimatedBytes) * 100)) : 100,
      label: String(label || '').slice(0, 120),
    });
  };

  let lastStagingDir = '';
  try {
    await fs.promises.mkdir(partialPath, { recursive: false });
    const payloadRoot = path.join(partialPath, encrypted ? 'payload' : 'data');
    await fs.promises.mkdir(payloadRoot, { recursive: true });
    for (const [index, entry] of normalizedEntries.entries()) {
      if (signal?.aborted || (typeof shouldCancel === 'function' && shouldCancel())) {
        throw archiveError(DATA_ERROR_CODES.INVALID_REQUEST, 'operation_cancelled', 'Archive creation was canceled.');
      }
      const entryId = crypto.randomUUID();
      const storedPath = encrypted
        ? `payload/${entryId}.bin`
        : `data/${entry.logicalPath}`;
      const destinationPath = resolveArchiveChild(partialPath, storedPath);
      notify('archiving', `Archiving ${index + 1} of ${normalizedEntries.length}`);
      let stagingDir;
      let result;
      let entryFailed = false;
      try {
        if (entry.produce) {
          await assertFreeSpace(entryStagingRoot || partialPath, entry.size);
          stagingDir = await fs.promises.mkdtemp(path.join(entryStagingRoot || partialPath, STAGING_PREFIX));
          lastStagingDir = stagingDir;
          const produced = await entry.produce(stagingDir);
          if (!produced) continue;
          if (!isPathInside(stagingDir, produced.sourcePath)
            || !isPathInside(fs.realpathSync.native(stagingDir), fs.realpathSync.native(produced.sourcePath))) {
            throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_archive_path', 'Archive entry escapes its root.');
          }
          const actualSize = sourceSnapshot(produced.sourcePath).size;
          estimatedBytes += actualSize - entry.size;
          if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > MAX_ARCHIVE_BYTES) {
            throw archiveError(DATA_ERROR_CODES.INVALID_REQUEST, 'archive_size_limit', 'Archive input exceeds the supported size limit.');
          }
          await assertFreeSpace(normalizedRoot, Math.max(0, estimatedBytes - completedBytes));
          entry.sourcePath = produced.sourcePath;
          entry.size = actualSize;
        }
        result = entry.data
          ? await writeBufferEntry({ entry, destinationPath, encrypt: encrypted, masterKey, salt, entryId })
          : await writeSourceEntry({ entry, destinationPath, encrypt: encrypted, masterKey, salt, entryId, signal });
      } catch (error) {
        entryFailed = true;
        throw error;
      } finally {
        if (stagingDir) await removeEntryStaging(stagingDir, entryFailed);
      }
      manifestEntries.push({
        entry_id: entryId,
        logical_path: entry.logicalPath,
        stored_path: storedPath,
        category: entry.category,
        size: result.size,
        sha256: result.sha256,
        ...(entry.restoreMetadata ? { restore_metadata: entry.restoreMetadata } : {}),
        ...(encrypted ? { iv: result.iv, tag: result.tag } : {}),
      });
      completedBytes += result.size;
      if (!Number.isSafeInteger(completedBytes) || completedBytes > MAX_ARCHIVE_BYTES) {
        throw archiveError(
          DATA_ERROR_CODES.SOURCE_UNREADABLE,
          'source_changed',
          'Archive sources grew beyond the supported size limit. No data was removed.'
        );
      }
    }

    const totalBytes = completedBytes;

    const categoryCounts = Object.fromEntries(manifestEntries.reduce((counts, entry) => {
      counts.set(entry.category, (counts.get(entry.category) || 0) + 1);
      return counts;
    }, new Map()));
    const manifest = {
      format: ARCHIVE_FORMAT,
      format_version: ARCHIVE_FORMAT_VERSION,
      created_at: createdAt.toISOString(),
      source_app_version: String(appVersion || '0.0.0'),
      entries: manifestEntries,
      category_counts: categoryCounts,
      total_bytes: totalBytes,
    };
    const envelope = {
      format: ARCHIVE_FORMAT,
      format_version: ARCHIVE_FORMAT_VERSION,
      created_at: manifest.created_at,
      source_app_version: manifest.source_app_version,
      encrypted: Boolean(encrypted),
      entry_count: manifestEntries.length,
      total_bytes: totalBytes,
    };
    if (encrypted) {
      const protectedManifest = encryptManifest(manifest, masterKey, salt);
      await fs.promises.writeFile(path.join(partialPath, 'manifest.enc'), protectedManifest.ciphertext, { flag: 'wx' });
      Object.assign(envelope, {
        kdf: { ...KDF_PROFILE },
        salt: encodeBase64(salt),
        manifest_iv: protectedManifest.iv,
        manifest_tag: protectedManifest.tag,
      });
    } else {
      await fs.promises.writeFile(
        path.join(partialPath, 'manifest.json'),
        JSON.stringify(manifest, null, 2),
        { encoding: 'utf8', flag: 'wx' }
      );
    }
    await fs.promises.writeFile(path.join(partialPath, 'archive.json'), JSON.stringify(envelope, null, 2), { encoding: 'utf8', flag: 'wx' });
    await fs.promises.writeFile(path.join(partialPath, 'README.txt'), buildReadme(encrypted), { encoding: 'utf8', flag: 'wx' });
    if (signal?.aborted || (typeof shouldCancel === 'function' && shouldCancel())) {
      throw archiveError(DATA_ERROR_CODES.INVALID_REQUEST, 'operation_cancelled', 'Archive creation was canceled.');
    }
    await fs.promises.writeFile(path.join(partialPath, COMPLETE_MARKER), `${manifest.created_at}${os.EOL}`, { encoding: 'utf8', flag: 'wx' });
    if (typeof onCommit === 'function') onCommit('verification');
    notify('verifying', 'Verifying the completed archive');
    await verifyArchive(partialPath, { passphrase });
    await fs.promises.rename(partialPath, finalPath);
    notify('complete', 'Archive verified');
    return {
      ok: true,
      status: 'complete',
      archivePath: finalPath,
      counts: { entries: manifestEntries.length, bytes: totalBytes, categories: categoryCounts },
      warnings: [],
    };
  } catch (error) {
    const failure = error.name === 'AbortError' && signal?.aborted
      ? archiveError(DATA_ERROR_CODES.INVALID_REQUEST, 'operation_cancelled', 'Archive creation was canceled.', error)
      : error;
    // Profile staging is outside the partial; retry a removal the entry could not finish.
    if (lastStagingDir) await fs.promises.rm(lastStagingDir, { recursive: true, force: true }).catch(() => {});
    await removeOrReportPartial(normalizedRoot, partialPath, failure);
    throw failure;
  }
}

function readBoundedFile(filePath, maxBytes) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) {
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_corrupt', 'Archive metadata is invalid.');
  }
  return fs.readFileSync(filePath);
}

function readEnvelope(archivePath) {
  const root = path.resolve(String(archivePath || ''));
  let rootStat;
  try {
    rootStat = fs.lstatSync(root);
  } catch (error) {
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_incomplete', 'Archive is incomplete.', error);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_archive_path', 'Archive directory is unsafe.');
  }
  const markerPath = path.join(root, COMPLETE_MARKER);
  if (!fs.existsSync(markerPath)) {
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_incomplete', 'Archive is incomplete.');
  }
  let envelope;
  try {
    readBoundedFile(markerPath, 256);
    envelope = JSON.parse(readBoundedFile(path.join(root, 'archive.json'), MAX_ENVELOPE_BYTES).toString('utf8'));
  } catch (error) {
    if (error instanceof Error && error.code?.startsWith?.('CMP-DATA-')) throw error;
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_corrupt', 'Archive envelope is unreadable.', error);
  }
  if (envelope?.format !== ARCHIVE_FORMAT || envelope?.format_version !== ARCHIVE_FORMAT_VERSION) {
    throw archiveError(DATA_ERROR_CODES.UNSUPPORTED_VERSION, 'unsupported_archive_version', 'Archive version is unsupported.');
  }
  if (
    typeof envelope.encrypted !== 'boolean'
    || typeof envelope.created_at !== 'string'
    || envelope.created_at.length > 64
    || !Number.isFinite(Date.parse(envelope.created_at))
    || typeof envelope.source_app_version !== 'string'
    || envelope.source_app_version.length > 64
    || !Number.isSafeInteger(envelope.entry_count)
    || envelope.entry_count < 0
    || envelope.entry_count > MAX_ARCHIVE_ENTRIES
    || !Number.isSafeInteger(envelope.total_bytes)
    || envelope.total_bytes < 0
    || envelope.total_bytes > MAX_ARCHIVE_BYTES
  ) {
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_corrupt', 'Archive envelope values are invalid.');
  }
  return { root, envelope };
}

async function readManifest(archivePath, { passphrase = '' } = {}) {
  const { root, envelope } = readEnvelope(archivePath);
  if (envelope.encrypted) {
    const ciphertext = readBoundedFile(path.join(root, 'manifest.enc'), MAX_MANIFEST_BYTES);
    const decrypted = await decryptManifest(ciphertext, envelope, passphrase);
    const manifest = validateManifest(decrypted.manifest, { encrypted: true });
    if (
      manifest.entries.length !== envelope.entry_count
      || manifest.total_bytes !== envelope.total_bytes
      || manifest.created_at !== envelope.created_at
      || manifest.source_app_version !== envelope.source_app_version
    ) {
      throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_corrupt', 'Archive envelope and manifest do not match.');
    }
    return { root, envelope, ...decrypted, manifest };
  }
  let manifest;
  try {
    manifest = JSON.parse(readBoundedFile(path.join(root, 'manifest.json'), MAX_MANIFEST_BYTES).toString('utf8'));
  } catch (error) {
    if (error instanceof Error && error.code?.startsWith?.('CMP-DATA-')) throw error;
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_corrupt', 'Archive manifest is unreadable.', error);
  }
  const validatedManifest = validateManifest(manifest, { encrypted: false });
  if (
    validatedManifest.entries.length !== envelope.entry_count
    || validatedManifest.total_bytes !== envelope.total_bytes
    || validatedManifest.created_at !== envelope.created_at
    || validatedManifest.source_app_version !== envelope.source_app_version
  ) {
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_corrupt', 'Archive envelope and manifest do not match.');
  }
  return { root, envelope, manifest: validatedManifest, masterKey: null, salt: null };
}

async function digestPlainFile(filePath) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(filePath), new Writable({
    write(chunk, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  }));
  return hash.digest('hex');
}

async function verifyArchive(archivePath, { passphrase = '', onProgress = null } = {}) {
  const state = await readManifest(archivePath, { passphrase });
  let completedBytes = 0;
  for (const [index, entry] of state.manifest.entries.entries()) {
    const storedPath = resolveArchiveChild(state.root, entry.stored_path);
    const stat = await fs.promises.lstat(storedPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.size) {
      throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_corrupt', 'Archive payload entry is missing.');
    }
    const digest = state.envelope.encrypted
      ? await decryptFileToSink({
          sourcePath: storedPath,
          masterKey: state.masterKey,
          salt: state.salt,
          entryId: entry.entry_id,
          iv: entry.iv,
          tag: entry.tag,
        })
      : await digestPlainFile(storedPath);
    if (digest !== entry.sha256) {
      throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_checksum_failed', 'Archive checksum verification failed.');
    }
    completedBytes += entry.size;
    if (typeof onProgress === 'function') {
      onProgress({
        phase: 'verifying',
        completedBytes,
        totalBytes: state.manifest.total_bytes,
        percent: state.manifest.total_bytes > 0
          ? Math.round((completedBytes / state.manifest.total_bytes) * 100)
          : 100,
        label: `Verifying ${index + 1} of ${state.manifest.entries.length}`,
      });
    }
  }
  return {
    ok: true,
    status: 'verified',
    encrypted: Boolean(state.envelope.encrypted),
    manifest: state.manifest,
  };
}

async function extractArchive(archivePath, destinationRoot, { passphrase = '' } = {}) {
  const state = await readManifest(archivePath, { passphrase });
  const outputRoot = path.resolve(String(destinationRoot || ''));
  await fs.promises.mkdir(outputRoot, { recursive: true });
  for (const entry of state.manifest.entries) {
    const sourcePath = resolveArchiveChild(state.root, entry.stored_path);
    const sourceStat = await fs.promises.lstat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size !== entry.size) {
      throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_corrupt', 'Archive payload entry is unsafe.');
    }
    const destinationPath = resolveArchiveChild(outputRoot, entry.logical_path);
    let digest;
    if (state.envelope.encrypted) {
      digest = await decryptFileToPath({
        sourcePath,
        destinationPath,
        masterKey: state.masterKey,
        salt: state.salt,
        entryId: entry.entry_id,
        iv: entry.iv,
        tag: entry.tag,
      });
    } else {
      digest = await copyFileWithDigest(sourcePath, destinationPath);
    }
    if (digest !== entry.sha256) {
      throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_checksum_failed', 'Archive checksum verification failed.');
    }
  }
  return { ok: true, status: 'extracted', manifest: state.manifest, destinationRoot: outputRoot };
}

module.exports = {
  ARCHIVE_EXTENSION,
  COMPLETE_MARKER,
  buildDefaultArchiveRoot,
  createArchive,
  extractArchive,
  isPathInside,
  readBoundedFile,
  readEnvelope,
  readManifest,
  verifyArchive,
};
