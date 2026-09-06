'use strict';

// Directory basenames the Explorer hides by default (workspaceFs.listDirectory
// honors an additive `showGenerated: true` opt-in). Two tiers:
//
// - Unambiguous names (node_modules, __pycache__, .venv, ...) are generated
//   wherever they appear and are hidden at any depth.
// - AMBIGUOUS names (build/dist/out/target) are common hand-authored module
//   names too, so hiding them by bare basename anywhere hides real source
//   (e.g. a `src/build/` module). They are treated as generated only when the
//   directory being listed also contains a build-manifest file — i.e. they sit
//   at a package/build root (workspace root with package.json, monorepo
//   packages/*/dist, a crate's target/). Without a manifest sibling they stay
//   visible.
const GENERATED_DIRECTORY_NAMES = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', 'target', '.cache',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.venv', 'venv', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.jenny', '.jenny-diagnostics',
]);

const AMBIGUOUS_GENERATED_DIRECTORY_NAMES = new Set(['build', 'dist', 'out', 'target']);

// Conservative "this directory is a package/build root" markers. Deliberately
// excludes weak signals like Makefile.
const BUILD_MANIFEST_FILE_NAMES = new Set([
  'package.json', 'pyproject.toml', 'setup.py', 'Cargo.toml', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts',
  'CMakeLists.txt', 'go.mod',
]);
const BUILD_MANIFEST_FILE_NAMES_LOWER = new Set(
  [...BUILD_MANIFEST_FILE_NAMES].map((name) => name.toLowerCase())
);

function normalizeForPlatform(name, platform) {
  const candidate = String(name || '');
  return platform === 'win32' ? candidate.toLowerCase() : candidate;
}

function isGeneratedDirectoryName(name, { platform = process.platform } = {}) {
  return GENERATED_DIRECTORY_NAMES.has(normalizeForPlatform(name, platform));
}

function isAmbiguousGeneratedDirectoryName(name, { platform = process.platform } = {}) {
  return AMBIGUOUS_GENERATED_DIRECTORY_NAMES.has(normalizeForPlatform(name, platform));
}

function isBuildManifestFileName(name, { platform = process.platform } = {}) {
  const candidate = String(name || '');
  return platform === 'win32'
    ? BUILD_MANIFEST_FILE_NAMES_LOWER.has(candidate.toLowerCase())
    : BUILD_MANIFEST_FILE_NAMES.has(candidate);
}

// Post-listing prune for listDirectory: once the full listing is known (a
// manifest sibling may appear after a candidate dir in iteration order), drop
// ambiguous generated dirs because the listed directory is a package/build root.
function pruneAmbiguousGeneratedEntries(entries, { platform = process.platform } = {}) {
  return entries.filter((entry) => !(entry.kind === 'directory'
    && isAmbiguousGeneratedDirectoryName(entry.name, { platform })));
}

module.exports = {
  BUILD_MANIFEST_FILE_NAMES,
  GENERATED_DIRECTORY_NAMES,
  isAmbiguousGeneratedDirectoryName,
  isBuildManifestFileName,
  isGeneratedDirectoryName,
  pruneAmbiguousGeneratedEntries,
};
