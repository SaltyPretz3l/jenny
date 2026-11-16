'use strict';

// The manifest of a team upload (slice 3-8a): a closed record per file
// (`path`, `size`, `sha256`), every path through the segment rules and the
// sensitive-name list (E69, path-segments.js), the E26
// caps, and no two entries that would land on one name. The transfer core
// knows nothing about projects, so this module answers the transfer reasons
// only; the install step (slice 3-8b) maps them to its own operation.
//
// Failures never echo a path, a size or a hash.

const { hostFailure } = require('../api-contract');
const { foldKey, sensitiveSegment, validateRelativePath } = require('./path-segments');

const MIB = 1024 * 1024;

// E26 and the spec defaults. A caller may pass lower values, never higher.
const TRANSFER_LIMITS = Object.freeze({
  maxFileBytes: 64 * MIB,
  maxUploadBytes: 512 * MIB,
  maxFiles: 10_000,
  maxPartBytes: 4 * MIB,
  maxUploadsPerOwner: 2,
  // Eight members times two uploads each.
  maxUploads: 16,
  // Declared bytes reserved across every upload in flight.
  maxReservedBytes: 2 * 1024 * MIB,
  idleMs: 60 * 60 * 1000,
});

const ENTRY_KEYS = Object.freeze(['path', 'sha256', 'size']);
const SHA256 = /^[0-9a-f]{64}$/u;

const invalid = () => hostFailure('invalid', 'team_upload_manifest_invalid');

function capped(limits, key) {
  const value = limits?.[key];
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, TRANSFER_LIMITS[key]) : TRANSFER_LIMITS[key];
}

function isClosedEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const prototype = Object.getPrototypeOf(entry);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(entry).sort();
  return keys.length === ENTRY_KEYS.length && keys.every((key, index) => key === ENTRY_KEYS[index]);
}

// Two names that fold alike (path-segments.js foldKey) collide. Two directories whose names fold alike but are
// spelled apart ('Dir/a' and 'dir/b') collide too: one file system would make two folders of them and another one.
function findCollision(files) {
  const fileKeys = new Set();
  const directories = new Map();
  for (const entry of files) {
    const key = foldKey(entry.path);
    if (fileKeys.has(key) || directories.has(key)) return true;
    fileKeys.add(key);
    const segments = entry.path.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      const spelled = segments.slice(0, depth).join('/');
      const folded = foldKey(spelled);
      if (fileKeys.has(folded)) return true;
      const seen = directories.get(folded);
      if (seen !== undefined && seen !== spelled) return true;
      directories.set(folded, spelled);
    }
  }
  return false;
}

/**
 * Validate a client manifest. Answers `{ ok: true, files, totalBytes }` with
 * frozen copies of the entries in their given order, or a hostFailure.
 */
function validateManifest(files, limits = {}) {
  const maxFiles = capped(limits, 'maxFiles');
  const maxFileBytes = capped(limits, 'maxFileBytes');
  const maxUploadBytes = capped(limits, 'maxUploadBytes');
  if (!Array.isArray(files) || files.length === 0) return invalid();
  if (files.length > maxFiles) return hostFailure('limit', 'team_upload_file_limit');
  const accepted = [];
  let totalBytes = 0;
  for (const entry of files) {
    if (!isClosedEntry(entry)) return invalid();
    const { path: filePath, size, sha256 } = entry;
    if (!Number.isSafeInteger(size) || size < 0) return invalid();
    if (typeof sha256 !== 'string' || !SHA256.test(sha256)) return invalid();
    // E69: a segment on the sensitive list (.git, .github, .vscode, .env, .jenny) is refused like a bad name.
    if (!validateRelativePath(filePath).ok || sensitiveSegment(filePath) !== null) {
      return hostFailure('invalid', 'team_project_path_invalid');
    }
    if (size > maxFileBytes) return hostFailure('limit', 'team_upload_size_limit');
    totalBytes += size;
    if (totalBytes > maxUploadBytes) return hostFailure('limit', 'team_upload_size_limit');
    accepted.push(Object.freeze({ path: filePath, size, sha256 }));
  }
  if (findCollision(accepted)) return invalid();
  return { ok: true, files: Object.freeze(accepted), totalBytes };
}

module.exports = { TRANSFER_LIMITS, foldKey, validateManifest };
