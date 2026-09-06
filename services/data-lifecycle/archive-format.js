'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { Transform, Writable } = require('stream');
const { DATA_ERROR_CODES } = require('../backend/error-codes');

const ARCHIVE_FORMAT = 'jenny-data-archive';
const ARCHIVE_FORMAT_VERSION = 1;
const KDF_PROFILE = Object.freeze({
  name: 'scrypt-v1',
  algorithm: 'scrypt',
  N: 131072,
  r: 8,
  p: 1,
  keyLength: 32,
  maxmem: 256 * 1024 * 1024,
});
const MAX_ARCHIVE_ENTRIES = 10_000;
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024 * 1024;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const ENTRY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

class DataArchiveError extends Error {
  constructor(code, reason, message, cause = null) {
    super(String(message || 'Jenny data archive operation failed.'));
    this.name = 'DataArchiveError';
    this.code = String(code || DATA_ERROR_CODES.ARCHIVE_CORRUPT);
    this.reason = String(reason || 'archive_invalid');
    if (cause) this.cause = cause;
  }
}

function archiveError(code, reason, message, cause) {
  return new DataArchiveError(code, reason, message, cause);
}

function encodeBase64(value) {
  return Buffer.from(value).toString('base64');
}

function decodeBase64(value, fieldName, expectedBytes = null) {
  const normalized = String(value || '');
  if (!normalized || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_corrupt', `Invalid ${fieldName}.`);
  }
  const decoded = Buffer.from(normalized, 'base64');
  if (expectedBytes != null && decoded.length !== expectedBytes) {
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_corrupt', `Invalid ${fieldName}.`);
  }
  return decoded;
}

function validatePassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) {
    throw archiveError(
      DATA_ERROR_CODES.INVALID_REQUEST,
      'invalid_passphrase',
      'Archive passphrase must contain between 12 and 1024 characters.'
    );
  }
  return passphrase;
}

function validateKdfProfile(profile) {
  const source = profile && typeof profile === 'object' ? profile : {};
  const valid = source.name === KDF_PROFILE.name
    && source.algorithm === KDF_PROFILE.algorithm
    && source.N === KDF_PROFILE.N
    && source.r === KDF_PROFILE.r
    && source.p === KDF_PROFILE.p
    && source.keyLength === KDF_PROFILE.keyLength;
  if (!valid) {
    throw archiveError(
      DATA_ERROR_CODES.UNSUPPORTED_VERSION,
      'unsupported_kdf_profile',
      'This archive uses an unsupported password-protection profile.'
    );
  }
  return KDF_PROFILE;
}

function deriveMasterKey(passphrase, salt, profile = KDF_PROFILE) {
  validatePassphrase(passphrase);
  const allowed = validateKdfProfile(profile);
  return new Promise((resolve, reject) => {
    crypto.scrypt(Buffer.from(passphrase, 'utf8'), salt, allowed.keyLength, {
      N: allowed.N,
      r: allowed.r,
      p: allowed.p,
      maxmem: allowed.maxmem,
    }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

function deriveEntryKey(masterKey, salt, entryId) {
  const info = Buffer.from(`jenny-archive-v1:${String(entryId || '')}`, 'utf8');
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, salt, info, 32));
}

function validateLogicalPath(value) {
  const logicalPath = String(value || '').normalize('NFC').replaceAll('\\', '/');
  if (!logicalPath || logicalPath.length > 512 || logicalPath.includes('\0')) {
    throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_archive_path', 'Archive entry path is invalid.');
  }
  if (logicalPath.startsWith('/') || /^[A-Za-z]:/.test(logicalPath)) {
    throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_archive_path', 'Archive entry path must be relative.');
  }
  const segments = logicalPath.split('/');
  if (segments.some((segment) => (
    !segment
    || segment === '.'
    || segment === '..'
    || segment.includes(':')
    || /[. ]$/.test(segment)
    || WINDOWS_RESERVED_NAME.test(segment)
  ))) {
    throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_archive_path', 'Archive entry path is unsafe.');
  }
  return segments.join('/');
}

function validateCategory(value, code = DATA_ERROR_CODES.ARCHIVE_CORRUPT, reason = 'archive_corrupt') {
  const category = String(value || '');
  if (!CATEGORY_PATTERN.test(category)) {
    throw archiveError(code, reason, 'Archive entry category is invalid.');
  }
  return category;
}

function resolveArchiveChild(rootPath, logicalPath) {
  const safeLogicalPath = validateLogicalPath(logicalPath);
  const root = path.resolve(String(rootPath || ''));
  const target = path.resolve(root, ...safeLogicalPath.split('/'));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw archiveError(DATA_ERROR_CODES.UNSAFE_PATH, 'unsafe_archive_path', 'Archive entry escapes its root.');
  }
  return target;
}

function createDigestTransform(hash) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

function createDigestSink(hash) {
  return new Writable({
    write(chunk, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  });
}

async function encryptFile({ sourcePath, destinationPath, masterKey, salt, entryId }) {
  const iv = crypto.randomBytes(12);
  const key = deriveEntryKey(masterKey, salt, entryId);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(entryId), 'utf8'));
  const hash = crypto.createHash('sha256');
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  await pipeline(
    fs.createReadStream(sourcePath),
    createDigestTransform(hash),
    cipher,
    fs.createWriteStream(destinationPath, { flags: 'wx' })
  );
  return {
    iv: encodeBase64(iv),
    tag: encodeBase64(cipher.getAuthTag()),
    sha256: hash.digest('hex'),
  };
}

async function encryptBuffer({ data, destinationPath, masterKey, salt, entryId }) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const iv = crypto.randomBytes(12);
  const key = deriveEntryKey(masterKey, salt, entryId);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(entryId), 'utf8'));
  const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  await fs.promises.writeFile(destinationPath, encrypted, { flag: 'wx' });
  return {
    iv: encodeBase64(iv),
    tag: encodeBase64(cipher.getAuthTag()),
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

// Stream-pipeline failures during decryption are either filesystem errors (they
// carry an E* code: ENOSPC, EACCES, EIO, ...) or GCM authentication failures (no
// fs code). Only the latter may be reported as a bad password / damaged archive.
function decryptFailure(error) {
  const filesystemCode = typeof error?.code === 'string' && /^E[A-Z0-9]+$/.test(error.code)
    ? error.code
    : '';
  if (filesystemCode) {
    return archiveError(
      filesystemCode === 'ENOSPC' ? DATA_ERROR_CODES.INSUFFICIENT_SPACE : DATA_ERROR_CODES.SOURCE_UNREADABLE,
      'archive_io_failed',
      filesystemCode === 'ENOSPC'
        ? 'Archive data could not be read or written because the destination has insufficient space.'
        : 'Archive data could not be read or written.',
      error
    );
  }
  return archiveError(
    DATA_ERROR_CODES.AUTHENTICATION_FAILED,
    'archive_authentication_failed',
    'Archive authentication failed. The password may be incorrect or the archive may be damaged.',
    error
  );
}

async function decryptFileToSink({ sourcePath, masterKey, salt, entryId, iv, tag }) {
  const key = deriveEntryKey(masterKey, salt, entryId);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, decodeBase64(iv, 'IV', 12));
  decipher.setAAD(Buffer.from(String(entryId), 'utf8'));
  decipher.setAuthTag(decodeBase64(tag, 'authentication tag', 16));
  const hash = crypto.createHash('sha256');
  try {
    await pipeline(fs.createReadStream(sourcePath), decipher, createDigestSink(hash));
  } catch (error) {
    throw decryptFailure(error);
  }
  return hash.digest('hex');
}

async function decryptFileToPath({ sourcePath, destinationPath, masterKey, salt, entryId, iv, tag }) {
  const key = deriveEntryKey(masterKey, salt, entryId);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, decodeBase64(iv, 'IV', 12));
  decipher.setAAD(Buffer.from(String(entryId), 'utf8'));
  decipher.setAuthTag(decodeBase64(tag, 'authentication tag', 16));
  const hash = crypto.createHash('sha256');
  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  try {
    await pipeline(
      fs.createReadStream(sourcePath),
      decipher,
      createDigestTransform(hash),
      fs.createWriteStream(destinationPath, { flags: 'wx' })
    );
  } catch (error) {
    await fs.promises.rm(destinationPath, { force: true }).catch(() => {});
    throw decryptFailure(error);
  }
  return hash.digest('hex');
}

function encryptManifest(manifest, masterKey, salt) {
  const entryId = 'manifest';
  const iv = crypto.randomBytes(12);
  const key = deriveEntryKey(masterKey, salt, entryId);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(ARCHIVE_FORMAT, 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext,
    iv: encodeBase64(iv),
    tag: encodeBase64(cipher.getAuthTag()),
  };
}

async function decryptManifest(ciphertext, envelope, passphrase) {
  const profile = validateKdfProfile(envelope.kdf);
  const salt = decodeBase64(envelope.salt, 'salt', 32);
  const masterKey = await deriveMasterKey(passphrase, salt, profile);
  const key = deriveEntryKey(masterKey, salt, 'manifest');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    decodeBase64(envelope.manifest_iv, 'manifest IV', 12)
  );
  decipher.setAAD(Buffer.from(ARCHIVE_FORMAT, 'utf8'));
  decipher.setAuthTag(decodeBase64(envelope.manifest_tag, 'manifest authentication tag', 16));
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return { manifest: JSON.parse(plaintext.toString('utf8')), masterKey, salt };
  } catch (error) {
    throw archiveError(
      DATA_ERROR_CODES.AUTHENTICATION_FAILED,
      'archive_authentication_failed',
      'Archive authentication failed. The password may be incorrect or the archive may be damaged.',
      error
    );
  }
}

function validateManifest(manifest, { encrypted = null } = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_corrupt', 'Archive manifest is invalid.');
  }
  if (manifest.format !== ARCHIVE_FORMAT || manifest.format_version !== ARCHIVE_FORMAT_VERSION) {
    throw archiveError(DATA_ERROR_CODES.UNSUPPORTED_VERSION, 'unsupported_archive_version', 'Archive version is unsupported.');
  }
  const entries = Array.isArray(manifest.entries) ? manifest.entries : null;
  if (!entries || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_entry_limit', 'Archive contains too many entries.');
  }
  let totalBytes = 0;
  const logicalPaths = new Set();
  const entryIds = new Set();
  const storedPaths = new Set();
  const categoryCounts = new Map();
  for (const entry of entries) {
    const logicalPath = validateLogicalPath(entry?.logical_path);
    const folded = logicalPath.normalize('NFC').toLocaleLowerCase('en-US');
    if (logicalPaths.has(folded)) {
      throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_path_collision', 'Archive contains colliding paths.');
    }
    logicalPaths.add(folded);
    const entryId = String(entry?.entry_id || '');
    if (!ENTRY_ID_PATTERN.test(entryId) || entryIds.has(entryId)) {
      throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_corrupt', 'Archive entry identity is invalid.');
    }
    entryIds.add(entryId);
    const storedPath = validateLogicalPath(entry?.stored_path);
    const expectedStoredPath = encrypted === true
      ? `payload/${entryId}.bin`
      : encrypted === false
        ? `data/${logicalPath}`
        : storedPath;
    const foldedStoredPath = storedPath.toLocaleLowerCase('en-US');
    if (storedPath !== expectedStoredPath || storedPaths.has(foldedStoredPath)) {
      throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_corrupt', 'Archive payload path is invalid.');
    }
    storedPaths.add(foldedStoredPath);
    const category = validateCategory(entry?.category);
    categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
    if (encrypted === true) {
      decodeBase64(entry?.iv, 'entry IV', 12);
      decodeBase64(entry?.tag, 'entry authentication tag', 16);
    }
    const size = Number(entry?.size);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_corrupt', 'Archive entry size is invalid.');
    }
    totalBytes += size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_ARCHIVE_BYTES) {
      throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_size_limit', 'Archive exceeds the supported size limit.');
    }
    if (!/^[a-f0-9]{64}$/.test(String(entry?.sha256 || ''))) {
      throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_corrupt', 'Archive entry checksum is invalid.');
    }
    if (entry.restore_metadata != null) {
      const keys = Object.keys(entry.restore_metadata || {});
      const sessionId = String(entry.restore_metadata?.session_id || '');
      if (
        keys.length !== 1
        || keys[0] !== 'session_id'
        || !sessionId
        || sessionId.length > 160
        || !/^[A-Za-z0-9._-]+$/.test(sessionId)
      ) {
        throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_corrupt', 'Archive restore metadata is invalid.');
      }
    }
  }
  if (manifest.total_bytes != null && Number(manifest.total_bytes) !== totalBytes) {
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_corrupt', 'Archive total size is inconsistent.');
  }
  const declaredCounts = manifest.category_counts;
  if (!declaredCounts || typeof declaredCounts !== 'object' || Array.isArray(declaredCounts)) {
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_corrupt', 'Archive category counts are invalid.');
  }
  const declaredKeys = Object.keys(declaredCounts).sort();
  const actualKeys = Array.from(categoryCounts.keys()).sort();
  if (
    declaredKeys.length !== actualKeys.length
    || declaredKeys.some((key, index) => (
      key !== actualKeys[index]
      || !Number.isSafeInteger(declaredCounts[key])
      || declaredCounts[key] !== categoryCounts.get(key)
    ))
  ) {
    throw archiveError(DATA_ERROR_CODES.ARCHIVE_CORRUPT, 'archive_corrupt', 'Archive category counts are inconsistent.');
  }
  return { ...manifest, entries, total_bytes: totalBytes };
}

module.exports = {
  ARCHIVE_FORMAT,
  ARCHIVE_FORMAT_VERSION,
  KDF_PROFILE,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  archiveError,
  decodeBase64,
  decryptFileToPath,
  decryptFileToSink,
  decryptManifest,
  deriveMasterKey,
  encodeBase64,
  encryptBuffer,
  encryptFile,
  encryptManifest,
  resolveArchiveChild,
  validateKdfProfile,
  validateCategory,
  validateLogicalPath,
  validateManifest,
  validatePassphrase,
};
