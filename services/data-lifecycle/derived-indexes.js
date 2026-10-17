'use strict';

const fs = require('fs');
const path = require('path');
const { removeFileSync } = require('../fs-remove-no-follow');

// Derived caches: sidecar-owned SQLite indexes rebuilt from canonical data
// (row 41 Knowledge semantic catalog, row 58 W4 chat index). They are never
// archived or restored, never make a profile non-fresh, are dropped after a
// restore promotion (stale for the restored profile), and cleanup/uninstall
// remove them with their WAL siblings and set-aside corrupt copies.
const DERIVED_INDEX_FILES = Object.freeze(['semantic-catalog.db', 'conversation-index.db']);
const SQLITE_SIBLING_SUFFIXES = Object.freeze(['', '-wal', '-shm']);
const DERIVED_INDEX_CHILDREN = Object.freeze(DERIVED_INDEX_FILES
  .flatMap((name) => SQLITE_SIBLING_SUFFIXES.map((suffix) => `${name}${suffix}`)));
// sidecar/ai/semantic/store.py `_set_aside_corrupt_file`:
// `<name>.corrupt-<%Y%m%dT%H%M%S%fZ>` plus the same suffix for -wal/-shm.
const CORRUPT_COPY_NAME = /^(.+)\.corrupt-\d{8}T\d{12}Z(?:-wal|-shm)?$/;

function isDerivedIndexCorruptCopy(name) {
  const base = CORRUPT_COPY_NAME.exec(String(name || ''))?.[1];
  return Boolean(base) && DERIVED_INDEX_FILES.includes(base);
}

// Inventory report rows: size only, never archive entries. A cache that cannot
// be inspected is left out rather than failing the archive.
function regularFileStat(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() ? stat : null;
  } catch (_error) {
    return null;
  }
}

function listDerivedIndexFiles(userDataPath) {
  const root = path.resolve(String(userDataPath || ''));
  const rows = [];
  for (const name of DERIVED_INDEX_CHILDREN) {
    const stat = regularFileStat(path.join(root, name));
    if (stat) rows.push({ name, size: stat.size, archived: false });
  }
  return rows;
}

// Never throws: a cache that cannot be removed is reported by fixed file name
// and reason code (the sidecar rebuilds or replaces it either way).
function removeDerivedIndexFiles(userDataPath) {
  const root = path.resolve(String(userDataPath || ''));
  const result = { removed: 0, retained: [] };
  for (const name of DERIVED_INDEX_CHILDREN) {
    try {
      const stat = fs.lstatSync(path.join(root, name));
      if (!stat.isFile() || stat.isSymbolicLink()) {
        result.retained.push({ name, reason: 'not_a_file' });
        continue;
      }
      removeFileSync(path.join(root, name));
      result.removed += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') result.retained.push({ name, reason: String(error?.code || 'remove_failed').slice(0, 40) });
    }
  }
  return result;
}

module.exports = {
  DERIVED_INDEX_CHILDREN,
  DERIVED_INDEX_FILES,
  isDerivedIndexCorruptCopy,
  listDerivedIndexFiles,
  removeDerivedIndexFiles,
};
