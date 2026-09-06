'use strict';

// Content-addressed package bytes: `packages/<sha256>/blob`
// (PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md "Package, identity, and storage":
// "packages/<sha256>/ - immutable, read-only package content"; invariant 15:
// "Restricted execution and view serving use the exact verified bytes ... .
// Reopening an untrusted mutable package path is never an execution
// primitive."). Every read verifies the actual bytes still hash to the
// address they are stored under; a mismatch is fail-closed corruption, never
// silently repaired or served.

const crypto = require('node:crypto');
const { joinPath } = require('./fs-facade');

const PACKAGES_DIR = 'packages';
const BLOB_FILE = 'blob';
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes, 'utf8').digest('hex');
}

function isValidDigest(value) {
  return typeof value === 'string' && DIGEST_PATTERN.test(value);
}

function contentDir(baseDir, digest) {
  return joinPath(baseDir, PACKAGES_DIR, digest);
}

function contentPath(baseDir, digest) {
  return joinPath(contentDir(baseDir, digest), BLOB_FILE);
}

// Writes `bytes` under its own content address. If the address already has
// content, verifies the existing bytes still match (self-consistency) instead
// of overwriting -- content-addressed storage is immutable by construction,
// so a caller re-putting identical bytes is a safe no-op, but pre-existing
// bytes that no longer hash to their own address are a fail-closed corruption,
// never silently replaced.
async function putContent(facade, baseDir, bytes) {
  const digest = sha256Hex(bytes);
  const dirPath = contentDir(baseDir, digest);
  const filePath = contentPath(baseDir, digest);
  const existing = await facade.stat(filePath);
  if (existing.exists) {
    const readBack = await facade.readFile(filePath, null);
    if (sha256Hex(readBack) !== digest) {
      return { ok: false, reason: 'existing_content_corrupted', digest };
    }
    return { ok: true, digest, alreadyExisted: true };
  }
  await facade.mkdir(dirPath);
  const tempPath = joinPath(dirPath, `${BLOB_FILE}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    await facade.writeFile(tempPath, bytes);
    await facade.fsyncFile(tempPath);
    await facade.renameFile(tempPath, filePath);
  } catch (error) {
    try {
      await facade.remove(tempPath);
    } catch (cleanupError) {
      void cleanupError;
    }
    throw error;
  }
  await facade.fsyncDir(dirPath);

  const verifyBytes = await facade.readFile(filePath, null);
  if (sha256Hex(verifyBytes) !== digest) {
    return { ok: false, reason: 'post_write_verification_failed', digest };
  }
  return { ok: true, digest, alreadyExisted: false };
}

async function getContent(facade, baseDir, digest) {
  if (!isValidDigest(digest)) {
    return { ok: false, reason: 'invalid_digest' };
  }
  const filePath = contentPath(baseDir, digest);
  let bytes;
  try {
    bytes = await facade.readFile(filePath, null);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return { ok: false, reason: 'content_not_found' };
    }
    throw error;
  }
  if (sha256Hex(bytes) !== digest) {
    return { ok: false, reason: 'digest_mismatch' };
  }
  return { ok: true, bytes };
}

// Cheap existence probe (no digest re-verification) used by reachability
// scans in gc.js -- correctness there comes from comparing digests already
// known to be reachable, not from re-hashing every blob on every scan.
async function hasContent(facade, baseDir, digest) {
  const stat = await facade.stat(contentPath(baseDir, digest));
  return stat.exists && stat.isFile;
}

// Lists only digests whose blob is actually present. The directory-name scan
// alone is not enough: removeContent deletes `packages/<digest>/blob` but the
// facade has no directory-removal primitive, so the now-empty `<digest>/`
// directory survives. Reporting it would mean GC never converges -- every
// later planGarbageCollection re-plans the same already-collected digests
// forever -- and any caller reading this as "what content exists" would
// over-report content whose bytes are gone (hasContent already says false).
async function listContentDigests(facade, baseDir) {
  const names = (await facade.list(joinPath(baseDir, PACKAGES_DIR))).filter(isValidDigest);
  const present = [];
  for (const digest of names) {
    if (await hasContent(facade, baseDir, digest)) present.push(digest);
  }
  return present;
}

async function removeContent(facade, baseDir, digest) {
  await facade.remove(contentPath(baseDir, digest));
}

module.exports = {
  PACKAGES_DIR,
  sha256Hex,
  isValidDigest,
  contentPath,
  putContent,
  getContent,
  hasContent,
  listContentDigests,
  removeContent,
};
