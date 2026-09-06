'use strict';

const {
  isAmbiguousGeneratedDirectoryName,
  isGeneratedDirectoryName,
} = require('./workspace-ide-generated-directories');

function createWalkIgnorePolicy({
  platform = process.platform,
  skipDotDirectories = true,
  extraSkipNames = [],
} = {}) {
  const configuredExtraSkipNames = [...extraSkipNames];
  // Match how workspace-ide-generated-directories.js compares names: case-fold
  // on win32, exact elsewhere. Without this, extraSkipNames would be the one
  // case-sensitive rule in an otherwise platform-normalized policy.
  const normalize = (value) => (platform === 'win32' ? String(value).toLowerCase() : String(value));
  const extraSkipNameSet = new Set(configuredExtraSkipNames.map(normalize));
  const platformOptions = { platform };

  function shouldSkipDirectory(name, _relPath) {
    if (!name) return false;
    const candidate = String(name);
    if (candidate === '.git') return true;
    if (skipDotDirectories && candidate.startsWith('.')) return true;
    if (extraSkipNameSet.has(normalize(candidate))) return true;
    // Ambiguous generated names may be hand-authored source directories.
    return isGeneratedDirectoryName(candidate, platformOptions)
      && !isAmbiguousGeneratedDirectoryName(candidate, platformOptions);
  }

  return {
    shouldSkipDirectory,
    shouldSkipPath(relPath) {
      if (!relPath) return false;
      const segments = String(relPath).split('/');
      return segments.slice(0, -1).some((segment) => shouldSkipDirectory(segment, ''));
    },
    describe() {
      return {
        source: 'names',
        skipDotDirectories,
        extraSkipNames: [...configuredExtraSkipNames],
      };
    },
  };
}

// Keep-set policies intentionally have no shouldSkipPath method. A git keep-set
// is a point-in-time snapshot, so using it for watcher events could hide a file
// the user created seconds later and prevent it from appearing in the Explorer.
function createKeepSetIgnorePolicy({ keepSet, platform = process.platform }) {
  const normalize = (value) => (platform === 'win32' ? String(value).toLowerCase() : String(value));
  const keptFiles = new Set();
  const includedDirs = new Set();
  for (const value of keepSet) {
    const relPath = normalize(value);
    keptFiles.add(relPath);
    let idx = relPath.indexOf('/');
    while (idx !== -1) {
      includedDirs.add(relPath.slice(0, idx));
      idx = relPath.indexOf('/', idx + 1);
    }
  }

  return {
    shouldSkipDirectory(name, relPath) {
      if (String(name) === '.git') return true;
      if (!relPath) return false;
      return !includedDirs.has(normalize(relPath));
    },
    describe() {
      return { source: 'git', keptFiles: keptFiles.size };
    },
  };
}

async function resolveWalkIgnorePolicy({
  gitService = null,
  signal = null,
  platform = process.platform,
  extraSkipNames = [],
} = {}) {
  const fallback = () => createWalkIgnorePolicy({ platform, extraSkipNames });
  if (!gitService || typeof gitService.listNonIgnoredFiles !== 'function') {
    return fallback();
  }
  try {
    const result = await gitService.listNonIgnoredFiles({ signal });
    if (result?.ok === true && Array.isArray(result.files) && result.files.length > 0) {
      // Deliberately recomputed per enumeration: git includes brand-new,
      // untracked-but-not-ignored files on the very next call.
      return createKeepSetIgnorePolicy({ keepSet: result.files, platform });
    }
  } catch (_error) {
    // Git inventory is an optimization; every failure degrades to names.
  }
  return fallback();
}

module.exports = {
  createKeepSetIgnorePolicy,
  createWalkIgnorePolicy,
  resolveWalkIgnorePolicy,
};
