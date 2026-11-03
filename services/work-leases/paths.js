'use strict';
// Path normalization, resource keys and lease-root resolution (protocol: "Lease root location",
// "Path normalization").

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { KIND_PATTERN, MAX_KEY_CHARS } = require('./record');

const SCOPE_CACHE_MS = 30_000;
const MAX_SCOPE_CACHE = 256;
const MAX_WALK_LEVELS = 64;
const WATCH_POLL_MS = 3_000;
const defaultScopeCache = new Map();

const isWindows = (platform) => platform === 'win32';

// `platform` is 'win32' or anything else (posix); the path is already realpath-resolved.
function normalizePathForKey(p, platform) {
  if (isWindows(platform)) {
    const folded = String(p).replace(/\\/gu, '/').toLowerCase().replace(/\/+$/u, '');
    return /^[a-z]:$/u.test(folded) ? `${folded}/` : folded;
  }
  const trimmed = String(p).replace(/\/+$/u, '');
  return trimmed === '' && String(p).startsWith('/') ? '/' : trimmed;
}

function resourceKey(kind, scopeKind, treePath, platform) {
  if (!KIND_PATTERN.test(kind)) throw new TypeError(`invalid resource kind: ${kind}`);
  let key;
  if (scopeKind === 'repo') key = `${kind}@repo`;
  else if (scopeKind === 'tree') key = `${kind}@tree:${normalizePathForKey(treePath, platform)}`;
  else throw new TypeError(`invalid resource scope: ${scopeKind}`);
  if (key.length > MAX_KEY_CHARS) throw new TypeError('resource key exceeds 512 characters');
  return key;
}

function realpathOf(p) {
  try {
    return (fs.realpathSync.native || fs.realpathSync)(p);
  } catch {
    return path.resolve(p);
  }
}

function userCacheDir(platform, env, homedir) {
  if (isWindows(platform)) return path.win32.join(env.LOCALAPPDATA || path.win32.join(homedir, 'AppData', 'Local'), 'Jenny');
  if (platform === 'darwin') return path.posix.join(homedir, 'Library', 'Caches', 'Jenny');
  return path.posix.join(env.XDG_CACHE_HOME || path.posix.join(homedir, '.cache'), 'jenny');
}

// Repository discovery from the filesystem alone, so the admission path never spawns git: `.git`
// is a directory (main worktree) or a `gitdir:` file (linked worktree, submodule), and a linked
// worktree's `commondir` names the shared git directory. GIT_DIR overrides and bare repositories
// read as plain folders.
function findRepository(start) {
  let dir = realpathOf(start);
  for (let level = 0; level < MAX_WALK_LEVELS; level += 1) {
    const dotGit = path.join(dir, '.git');
    let stat = null;
    try { stat = fs.statSync(dotGit); } catch { /* not at this level */ }
    if (stat) {
      let gitDir = dotGit;
      if (stat.isFile()) {
        const match = /^gitdir:\s*(.+?)\s*$/mu.exec(fs.readFileSync(dotGit, 'utf8'));
        if (!match) return null;
        gitDir = path.resolve(dir, match[1]);
      }
      let commonDir = gitDir;
      try {
        commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
      } catch { /* a main worktree's git dir is the common dir */ }
      return { treeRoot: dir, gitCommonDir: realpathOf(commonDir) };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

// A repository's lease root lives in its common git directory; a plain folder's in the user cache.
function resolveLeaseScope(dir, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const cache = options.cache || defaultScopeCache;
  const nowMs = options.nowMs || Date.now;
  const find = options.findRepository || findRepository;
  const resolved = path.resolve(dir);
  const cacheKey = `${platform}|${resolved}`;
  const hit = cache.get(cacheKey);
  if (hit && nowMs() - hit.at < SCOPE_CACHE_MS) return hit.scope;

  let repo;
  try { repo = find(resolved); } catch { repo = null; }
  let scope;
  if (repo) {
    scope = { leaseRoot: path.join(repo.gitCommonDir, 'jenny', 'leases', 'v1'), ...repo, isRepo: true };
  } else {
    const treeRoot = realpathOf(resolved);
    const hash = crypto.createHash('sha256').update(normalizePathForKey(treeRoot, platform)).digest('hex').slice(0, 16);
    const home = options.homedir || os.homedir();
    const cacheDir = userCacheDir(platform, env, home);
    scope = { leaseRoot: (isWindows(platform) ? path.win32 : path.posix).join(cacheDir, 'leases', 'v1', hash), treeRoot, gitCommonDir: null, isRepo: false };
  }
  Object.freeze(scope);
  cache.delete(cacheKey);
  cache.set(cacheKey, { at: nowMs(), scope });
  if (cache.size > MAX_SCOPE_CACHE) cache.delete(cache.keys().next().value);
  return scope;
}

function deriveCommonDir(leaseRoot) {
  const parts = [leaseRoot, path.dirname(leaseRoot), path.dirname(path.dirname(leaseRoot))];
  const names = parts.map((p) => path.basename(p).toLowerCase());
  return names[0] === 'v1' && names[1] === 'leases' && names[2] === 'jenny'
    ? path.dirname(parts[2]) : null;
}

// fs.watch on the tickets directory, falling back to a 3 s file-name poll when it throws or errors.
// Returns a stop function. `fire` is the caller's (debounced) change callback.
function watchDirectory(dir, fire) {
  let watcher = null;
  let poll = null;
  const signature = () => {
    try { return fs.readdirSync(dir).sort().join('|'); } catch { return ''; }
  };
  const startPoll = () => {
    if (poll) return;
    let last = signature();
    poll = setInterval(() => {
      const next = signature();
      if (next !== last) { last = next; fire(); }
    }, WATCH_POLL_MS);
    poll.unref();
  };
  try {
    watcher = fs.watch(dir, { persistent: false }, fire);
    watcher.on('error', () => {
      try { watcher.close(); } catch { /* already closed */ }
      watcher = null;
      startPoll();
    });
  } catch {
    startPoll();
  }
  return () => {
    clearInterval(poll);
    if (watcher) try { watcher.close(); } catch { /* already closed */ }
  };
}

module.exports = {
  normalizePathForKey, resourceKey, resolveLeaseScope, findRepository, deriveCommonDir, watchDirectory,
};
