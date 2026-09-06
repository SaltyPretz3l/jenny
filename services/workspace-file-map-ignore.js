'use strict';

// Workspace File Map — gitignore-aware scan scope.
//
// Pure, DOM-free, IPC-free (no `require` of the engine or any IO module).
// Partitions the full workspace file list returned by WorkspaceIdeService
// into files the scan should actually read/parse ("included") and files it
// should not (build output, vendored deps, binaries, ...) — without ever
// silently dropping the latter: every excluded top-level directory is
// summarized into a single "bucket" node instead, so nothing disappears from
// the graph, it just gets collapsed into a per-directory count.
//
// Two partitioning strategies:
//  - partitionByKeepSet: git is available — `keepSet` is the authoritative
//    non-ignored file list (from WorkspaceGitService.listNonIgnoredFiles,
//    itself `git ls-files --cached --others --exclude-standard`). Everything
//    in allFiles NOT in keepSet is bucketed.
//  - fallbackPartition: no git (or a fail-soft degrade to it) — a
//    conservative directory + extension denylist stands in for gitignore.
//
// All workspace paths are POSIX-style (forward slash), relative to the
// workspace root, with no leading "./" — matching
// workspace-file-map-engine's own convention.

// Every ANCESTOR directory that contains at least one INCLUDED file. Used to
// locate the shallowest fully-excluded ancestor of an excluded file (below).
function includedDirSet(includedFiles) {
  const dirs = new Set();
  for (const relPath of includedFiles) {
    let idx = relPath.indexOf('/');
    while (idx !== -1) {
      dirs.add(relPath.slice(0, idx));
      idx = relPath.indexOf('/', idx + 1);
    }
  }
  return dirs;
}

// The SHALLOWEST ancestor directory of relPath whose entire subtree is excluded
// (i.e. not present in includedDirs). This collapses a wholly-excluded tree
// (node_modules/**, artifacts/**) into one top-level bucket, while a partial
// directory that also holds tracked source (e.g. docs/ with docs/manifests/*
// kept but docs/archive/* ignored) buckets only its excluded subtree
// (docs/archive) — never the top-level dir. A bucket therefore never shares a
// name with, and collides against, a folder region of real nodes. A file with
// no fully-excluded ancestor dir (a root-level ignored file, or one sitting
// directly inside a partial dir) folds into the single '.' catch-all bucket.
function bucketDirFor(relPath, includedDirs) {
  let idx = relPath.indexOf('/');
  while (idx !== -1) {
    const prefix = relPath.slice(0, idx);
    if (!includedDirs.has(prefix)) return prefix;
    idx = relPath.indexOf('/', idx + 1);
  }
  return '.';
}

// Groups excluded relPaths into { dir, count } buckets keyed by their shallowest
// fully-excluded ancestor directory (see bucketDirFor), sorted by dir for
// deterministic output. includedDirs is the set of ancestor dirs holding at
// least one included file.
function groupIntoBuckets(excludedFiles, includedDirs) {
  const countByDir = new Map();
  for (const relPath of excludedFiles) {
    const dir = bucketDirFor(relPath, includedDirs);
    countByDir.set(dir, (countByDir.get(dir) || 0) + 1);
  }
  return [...countByDir.entries()]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
}

// keepSet: Set<string> of non-ignored files (from git). `included` is the
// INTERSECTION with the already-bounded WorkspaceIdeService enumeration.
// Git output can be much larger than that enumeration, so treating keepSet as
// the source list would bypass the File Map's file cap. `buckets` summarizes
// everything in allFiles that keepSet does NOT claim.
function partitionByKeepSet(allFiles, keepSet) {
  const included = Array.from(new Set(allFiles.filter((relPath) => keepSet.has(relPath)))).sort();
  const ignored = allFiles.filter((relPath) => !keepSet.has(relPath));
  return { included, buckets: groupIntoBuckets(ignored, includedDirSet(included)) };
}

const DENYLIST_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.cache',
  'vendor', 'artifacts', '__pycache__', '.venv', 'venv', 'target', '.next', '.turbo',
]);

const DENYLIST_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'svg', 'pdf',
  'zip', 'gz', 'tgz', 'tar', 'exe', 'dll', 'so', 'dylib',
  'woff', 'woff2', 'ttf', 'eot', 'otf',
  'mp4', 'mp3', 'wav', 'mov', 'lock',
]);

function extensionOf(relPath) {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1);
  const idx = base.lastIndexOf('.');
  return idx <= 0 ? '' : base.slice(idx + 1).toLowerCase();
}

function isDenylistedPath(relPath) {
  const segments = relPath.split('/');
  if (segments.some((segment) => DENYLIST_DIRS.has(segment))) return true;
  return DENYLIST_EXTENSIONS.has(extensionOf(relPath));
}

// No-git fallback. Order-preserving: callers (the service's content-read
// loop) rely on `included` matching the original listAllFiles() walk order.
function fallbackPartition(allFiles) {
  const included = [];
  const ignored = [];
  for (const relPath of allFiles) {
    if (isDenylistedPath(relPath)) {
      ignored.push(relPath);
    } else {
      included.push(relPath);
    }
  }
  return { included, buckets: groupIntoBuckets(ignored, includedDirSet(included)) };
}

// Bucket summary nodes carry the FULL engine node shape (so any code that
// assumes every graph.nodes[] entry has the standard fields never has to
// special-case a bucket) plus `bucket: true` and `count`. `buckets` is
// already sorted by dir (both partition functions produce it that way via
// groupIntoBuckets), so this preserves that order rather than re-sorting.
function buildBucketNodes(buckets) {
  return buckets.map(({ dir, count }) => ({
    id: `bucket:${dir}`,
    // The '.' catch-all (root-level ignored files + files sitting directly in a
    // partial dir) reads as "(ignored)" so its card never duplicates the
    // layout's "(root)" folder band of real root nodes.
    label: dir === '.' ? '(ignored)' : dir,
    dir,
    isTest: false,
    loc: 0,
    inbound: 0,
    outbound: 0,
    cochangeDegree: 0,
    importance: 0,
    externalRefs: 0,
    x: 0,
    y: 0,
    bucket: true,
    count,
  }));
}

module.exports = {
  partitionByKeepSet,
  fallbackPartition,
  buildBucketNodes,
};
