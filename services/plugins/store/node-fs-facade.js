'use strict';

// The real-filesystem adapter for the fs-facade contract (store/fs-facade.js).
//
// **This is the ONLY file under `services/plugins/` permitted to
// `require('node:fs')`.** Every other store/lifecycle module takes a facade as
// an injected parameter, and that single rule is what makes the whole Stage-3
// durability proof transferable: W4's crash-injecting facade, Stage 2's
// in-memory facade, and this real-disk adapter all occupy the same slot, so a
// test that pins fully-old-or-fully-new behaviour against one of them is
// pinning behaviour the shipping store actually has.
//
// Two properties this file exists to keep true:
//
//   1. THE DURABILITY PRIMITIVES STAY SEPARATE. mkdir / writeFile / fsyncFile
//      / renameFile / fsyncDir are five distinct calls and are deliberately
//      NOT folded into one "atomic write" helper. Separateness is exactly what
//      crash injection hangs off: a wrapping facade can fail/delay/reorder any
//      single step (write the temp bytes but never fsync them; fsync but never
//      rename; rename but never fsync the directory). Collapsing them into one
//      helper here would silently delete every one of those crash points while
//      the tests kept passing, which is the worst possible failure mode for a
//      durability suite.
//
//   2. ERRORS NORMALIZE TO THE MEMORY FACADE'S SHAPES. A caller must not be
//      able to tell the two apart, so the ENOENT/EISDIR codes, the message
//      text, and `error.path` are reproduced exactly as MemoryFsFacade
//      produces them -- including the deliberate choice to set `error.path` to
//      the caller's LOGICAL path, never the resolved absolute path. That is
//      both parity and redaction: a raw userData path must never ride out on
//      an error that reaches an audit record or the renderer.
//
// The normalization rule, stated once and applied everywhere below: error
// codes the memory facade CAN produce (ENOENT, EISDIR) are normalized to its
// exact shape; failures only a real disk can produce (EACCES, EBUSY, EMFILE,
// ENOSPC, an antivirus-held rename) are propagated unchanged, because
// swallowing them would be a durability lie and there is no memory-facade
// behaviour to be consistent with.
//
// Windows directory fsync: `fs.fsync` on a directory handle is not supported
// on Windows the way it is on POSIX. `fsyncDir` therefore NEVER throws (the
// facade contract requires that) but it also never pretends: every degradation
// is counted and reported through `directoryFsyncReport()`, and logged once,
// because a silently no-op fsync is a durability claim the store cannot back.
// PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md treats this as a recovery concern:
// recovery.js must be able to repair a store whose directory entries were
// never flushed, and it can only be trusted to do so if we know when that
// happened.

const fs = require('node:fs');
const nodePath = require('node:path');

const { FACADE_METHODS, normalizePath } = require('./fs-facade');

const fsp = fs.promises;
const NO_FOLLOW_FLAG = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW || 0);
const TRANSIENT_WINDOWS_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const WINDOWS_RENAME_RETRY_DELAYS_MS = Object.freeze([25, 50, 100, 200]);

// Error codes a real filesystem raises that the memory facade expresses as a
// plain ENOENT (a missing parent directory, a directory where a file was
// expected, a path component that is a file). Grouped here so the mapping is
// one list rather than five repeated conditionals.
const ENOENT_EQUIVALENT_CODES = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

function enoent(message, targetPath) {
  const error = new Error(message);
  error.code = 'ENOENT';
  error.path = targetPath;
  return error;
}

function eisdir(message, targetPath) {
  const error = new Error(message);
  error.code = 'EISDIR';
  error.path = targetPath;
  return error;
}

function pathEscape(logicalPath) {
  const error = new Error(`ERR_PATH_ESCAPES_ROOT: refusing path outside the facade root: '${logicalPath}'`);
  error.code = 'ERR_PATH_ESCAPES_ROOT';
  error.path = logicalPath;
  return error;
}

function reparsePoint(logicalPath) {
  const error = new Error(`ERR_PATH_REPARSE_POINT: refusing linked store path: '${logicalPath}'`);
  error.code = 'ERR_PATH_REPARSE_POINT';
  error.path = logicalPath;
  return error;
}

function rootIdentityChanged(logicalPath) {
  const error = new Error(`ERR_STORE_ROOT_CHANGED: refusing replaced store root for: '${logicalPath}'`);
  error.code = 'ERR_STORE_ROOT_CHANGED';
  error.path = logicalPath;
  return error;
}

function comparablePath(value) {
  const resolved = nodePath.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function realPathIsContained(rootReal, candidateReal) {
  const root = comparablePath(rootReal);
  const candidate = comparablePath(candidateReal);
  const relative = nodePath.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${nodePath.sep}`)
    && !nodePath.isAbsolute(relative)
  );
}

function codeOf(error) {
  return error && typeof error.code === 'string' ? error.code : '';
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryTransientRename(operation, options = {}) {
  const platform = options.platform || process.platform;
  const sleep = options.sleep || delay;
  const onRetry = options.onRetry || (() => {});
  let retryIndex = 0;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      const retryable = platform === 'win32' && TRANSIENT_WINDOWS_RENAME_CODES.has(codeOf(error));
      if (!retryable || retryIndex >= WINDOWS_RENAME_RETRY_DELAYS_MS.length) {
        throw error;
      }
      const waitMs = WINDOWS_RENAME_RETRY_DELAYS_MS[retryIndex];
      retryIndex += 1;
      onRetry(error, retryIndex, waitMs);
      await sleep(waitMs);
    }
  }
}

// Logical (POSIX, root-relative) -> real absolute path, refusing anything that
// resolves outside `rootDir`. store-paths.js already validates every
// parameterized segment before composing a path, so reaching this refusal
// means a bug or an attack got past that layer -- it is defense in depth, and
// deliberately a throw rather than a soft result, matching store-paths.js's
// own assertContained convention for structurally-impossible-if-correct
// conditions.
//
// This is a divergence FROM the memory facade in the safe direction: the
// memory facade has no real disk to escape onto, so it treats '../x' as an
// ordinary map key. There is no reachable store-module path that produces one.
function resolveUnderRoot(rootDir, logicalPath) {
  const normalized = normalizePath(logicalPath);
  if (normalized === '') return rootDir;
  if (normalized === '..' || normalized.startsWith('../')) {
    throw pathEscape(logicalPath);
  }
  const resolved = nodePath.resolve(rootDir, normalized);
  const relative = nodePath.relative(rootDir, resolved);
  if (relative !== '' && (relative === '..' || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative))) {
    throw pathEscape(logicalPath);
  }
  return resolved;
}

// The real-disk facade. Method-for-method identical in signature and, where
// the memory facade can express the outcome at all, in observable behaviour to
// MemoryFsFacade -- verified against that implementation, not assumed.
class NodeFsFacade {
  /**
   * @param {object} params
   * @param {string} params.rootDir absolute directory every logical path is
   *   resolved under; nothing this facade does can touch anything outside it.
   * @param {function} [params.log] `(level, event, fields)` house logger,
   *   used only for the directory-fsync degradation notice.
   */
  constructor({ rootDir, log = null } = {}) {
    if (typeof rootDir !== 'string' || !rootDir || !nodePath.isAbsolute(rootDir)) {
      throw new TypeError('NodeFsFacade requires an absolute rootDir.');
    }
    this.rootDir = nodePath.resolve(rootDir);
    this._rootReal = null;
    this._rootIdentity = null;
    try {
      const rootStats = fs.lstatSync(this.rootDir);
      if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
        throw reparsePoint('');
      }
      this._rootReal = fs.realpathSync.native(this.rootDir);
      this._rootIdentity = { dev: rootStats.dev, ino: rootStats.ino };
    } catch (error) {
      if (codeOf(error) !== 'ENOENT') throw error;
    }
    this._log = typeof log === 'function' ? log : () => {};
    // Parity with MemoryFsFacade: tests count facade calls to prove a code
    // path touched (or, more often, did NOT touch) the store at all.
    this.callCounts = {
      readFile: 0,
      writeFile: 0,
      fsyncFile: 0,
      renameFile: 0,
      fsyncDir: 0,
      list: 0,
      remove: 0,
      removeTree: 0,
      stat: 0,
      mkdir: 0,
    };
    // Explicit directory-fsync degradation accounting (see module header).
    this._dirFsync = { attempted: 0, succeeded: 0, degraded: 0, lastCode: null, notified: false };
  }

  _resolve(logicalPath) {
    return resolveUnderRoot(this.rootDir, logicalPath);
  }

  async _verifyRoot(logicalPath) {
    let currentRoot;
    try {
      currentRoot = await fsp.lstat(this.rootDir);
    } catch (error) {
      if (codeOf(error) !== 'ENOENT' && codeOf(error) !== 'ENOTDIR') throw error;
      if (this._rootIdentity !== null) throw rootIdentityChanged(logicalPath);
      return false;
    }
    if (currentRoot.isSymbolicLink() || !currentRoot.isDirectory()) {
      throw reparsePoint(logicalPath);
    }
    const currentRootReal = await fsp.realpath(this.rootDir);
    if (this._rootIdentity === null) {
      const confirmedRoot = await fsp.lstat(this.rootDir);
      if (
        confirmedRoot.isSymbolicLink()
        || !confirmedRoot.isDirectory()
        || confirmedRoot.dev !== currentRoot.dev
        || confirmedRoot.ino !== currentRoot.ino
      ) {
        throw rootIdentityChanged(logicalPath);
      }
      this._rootReal = currentRootReal;
      this._rootIdentity = { dev: currentRoot.dev, ino: currentRoot.ino };
      return true;
    }
    if (currentRoot.dev !== this._rootIdentity.dev || currentRoot.ino !== this._rootIdentity.ino) {
      throw rootIdentityChanged(logicalPath);
    }
    if (comparablePath(currentRootReal) !== comparablePath(this._rootReal)) {
      throw rootIdentityChanged(logicalPath);
    }
    return true;
  }

  async _ensureRoot(logicalPath) {
    if (await this._verifyRoot(logicalPath)) return;
    try {
      await fsp.mkdir(this.rootDir, { recursive: false });
    } catch (error) {
      if (codeOf(error) !== 'EEXIST') throw error;
    }
    if (!await this._verifyRoot(logicalPath)) throw rootIdentityChanged(logicalPath);
  }

  async _resolveSafe(logicalPath) {
    const resolved = this._resolve(logicalPath);
    if (!await this._verifyRoot(logicalPath)) return resolved;

    const relative = nodePath.relative(this.rootDir, resolved);
    const parts = relative === '' ? [] : relative.split(nodePath.sep);
    let cursor = this.rootDir;
    for (const part of parts) {
      cursor = nodePath.join(cursor, part);
      let stats;
      try {
        stats = await fsp.lstat(cursor);
      } catch (error) {
        if (codeOf(error) === 'ENOENT' || codeOf(error) === 'ENOTDIR') break;
        throw error;
      }
      if (stats.isSymbolicLink()) throw reparsePoint(logicalPath);
      const canonical = await fsp.realpath(cursor);
      if (!realPathIsContained(this._rootReal, canonical)) throw pathEscape(logicalPath);
    }
    return resolved;
  }

  async mkdir(dirPath) {
    this.callCounts.mkdir += 1;
    await this._ensureRoot(dirPath);
    const resolved = await this._resolveSafe(dirPath);
    await fsp.mkdir(resolved, { recursive: true });
    await this._resolveSafe(dirPath);
  }

  // Whole-file write. The parent directory must already exist, exactly as the
  // memory facade requires -- a real `fs.writeFile` gives ENOENT for a missing
  // parent and ENOTDIR when a parent component is a file, and the memory
  // facade expresses both as the same "parent directory does not exist"
  // ENOENT, so both normalize to that one shape.
  async writeFile(filePath, contents) {
    this.callCounts.writeFile += 1;
    try {
      const payload = Buffer.isBuffer(contents) ? contents : String(contents);
      const resolved = await this._resolveSafe(filePath);
      const handle = await fsp.open(
        resolved,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | NO_FOLLOW_FLAG,
        0o600
      );
      try {
        await handle.writeFile(payload, Buffer.isBuffer(payload) ? undefined : { encoding: 'utf8' });
      } finally {
        await handle.close();
      }
      await this._resolveSafe(filePath);
    } catch (error) {
      if (ENOENT_EQUIVALENT_CODES.has(codeOf(error))) {
        throw enoent(`ENOENT: parent directory does not exist, open '${filePath}'`, filePath);
      }
      throw error;
    }
  }

  async readFile(filePath, encoding = 'utf8') {
    this.callCounts.readFile += 1;
    let handle;
    try {
      const resolved = await this._resolveSafe(filePath);
      handle = await fsp.open(resolved, fs.constants.O_RDONLY | NO_FOLLOW_FLAG);
      return await handle.readFile(encoding === null ? undefined : { encoding });
    } catch (error) {
      if (ENOENT_EQUIVALENT_CODES.has(codeOf(error))) {
        throw enoent(`ENOENT: no such file, open '${filePath}'`, filePath);
      }
      throw error;
    } finally {
      if (handle) await handle.close();
    }
  }

  // The file-scoped durability barrier. Opened 'r+' rather than 'r' because
  // Windows' FlushFileBuffers requires write access on the handle -- a
  // read-only handle would fail with EACCES and turn every fsync into a
  // reported failure on the platform Jenny primarily ships on.
  async fsyncFile(filePath) {
    this.callCounts.fsyncFile += 1;
    let handle;
    try {
      handle = await fsp.open(
        await this._resolveSafe(filePath),
        fs.constants.O_RDWR | NO_FOLLOW_FLAG
      );
    } catch (error) {
      if (ENOENT_EQUIVALENT_CODES.has(codeOf(error))) {
        throw enoent(`ENOENT: no such file, fsync '${filePath}'`, filePath);
      }
      throw error;
    }
    try {
      await handle.sync();
    } finally {
      // The barrier has already completed (or thrown) by here; a close failure
      // leaks a descriptor but cannot un-flush the bytes, so it is logged
      // rather than allowed to mask the sync outcome.
      try {
        await handle.close();
      } catch (closeError) {
        this._log('WARN', 'plugins.fsync_handle_close_failed', { code: codeOf(closeError) });
      }
    }
  }

  // Atomic same-volume replace. Node maps this to MoveFileEx with
  // MOVEFILE_REPLACE_EXISTING on Windows and rename(2) on POSIX, so an
  // existing destination is replaced in both -- matching the memory facade,
  // which silently overwrites a duplicate target.
  //
  // The ENOENT branch re-derives which side was missing, on the error path
  // only, so the thrown shape (message AND `error.path`) matches the memory
  // facade's two distinct ENOENTs exactly rather than approximately. Windows
  // scanners can hold either path briefly and return EPERM/EACCES/EBUSY; those
  // codes receive a bounded 375ms retry window, then still propagate unchanged
  // so the durability layer never reports a write that did not commit.
  async renameFile(oldPath, newPath) {
    this.callCounts.renameFile += 1;
    const realOld = await this._resolveSafe(oldPath);
    const realNew = await this._resolveSafe(newPath);
    try {
      await retryTransientRename(
        () => fsp.rename(realOld, realNew),
        {
          onRetry: (error, attempt, waitMs) => this._log(
            'WARN',
            'plugins.rename_transient_retry',
            { code: codeOf(error), attempt, wait_ms: waitMs }
          ),
        }
      );
      await this._resolveSafe(newPath);
    } catch (error) {
      if (!ENOENT_EQUIVALENT_CODES.has(codeOf(error))) throw error;
      const sourceExists = await fsp.stat(realOld).then(() => true, () => false);
      if (!sourceExists) {
        throw enoent(`ENOENT: no such file, rename '${oldPath}' -> '${newPath}'`, oldPath);
      }
      throw enoent(
        `ENOENT: destination directory does not exist, rename '${oldPath}' -> '${newPath}'`,
        newPath
      );
    }
  }

  // Best-effort by contract: NEVER throws, for any reason, including an
  // unknown directory -- identical to the memory facade, which counts the call
  // and returns. Unlike the memory facade it records WHY it degraded, because
  // on Windows the degradation is the normal case and a store whose directory
  // entries were never flushed is a recovery input, not a non-event.
  async fsyncDir(dirPath) {
    this.callCounts.fsyncDir += 1;
    this._dirFsync.attempted += 1;
    let handle;
    try {
      handle = await fsp.open(await this._resolveSafe(dirPath), 'r');
    } catch (error) {
      this._recordDirFsyncDegradation(codeOf(error) || 'open_failed');
      return;
    }
    try {
      await handle.sync();
      this._dirFsync.succeeded += 1;
    } catch (error) {
      this._recordDirFsyncDegradation(codeOf(error) || 'sync_failed');
    } finally {
      try {
        await handle.close();
      } catch (closeError) {
        this._log('WARN', 'plugins.fsync_handle_close_failed', { code: codeOf(closeError) });
      }
    }
  }

  _recordDirFsyncDegradation(code) {
    this._dirFsync.degraded += 1;
    this._dirFsync.lastCode = code;
    if (this._dirFsync.notified) return;
    // Logged ONCE per facade. On Windows this fires on the first commit and
    // then stays quiet; the counters below remain queryable for the whole
    // process lifetime, so the degradation is inspectable without being noisy.
    this._dirFsync.notified = true;
    const level = code === 'EPERM' && process.platform === 'win32' ? 'INFO' : 'WARN';
    this._log(level, 'plugins.directory_fsync_unsupported', {
      code,
      platform: process.platform,
      detail: 'directory fsync degraded; treat directory-entry durability as a recovery concern',
    });
  }

  /**
   * @returns {{attempted:number,succeeded:number,degraded:number,lastCode:string|null,supported:boolean|null}}
   *   `supported` is null until the first attempt, then true iff every attempt
   *   so far flushed. Exported so a caller (or a test) can assert the platform
   *   posture instead of assuming it.
   */
  directoryFsyncReport() {
    const { attempted, succeeded, degraded, lastCode } = this._dirFsync;
    return {
      attempted,
      succeeded,
      degraded,
      lastCode,
      supported: attempted === 0 ? null : degraded === 0,
    };
  }

  // Immediate child names, sorted, `[]` for an absent directory -- the memory
  // facade sorts, and readdir's order is filesystem-dependent, so sorting here
  // is required for the two to be interchangeable. ENOTDIR joins ENOENT
  // because listing a FILE path returns `[]` from the memory facade too.
  async list(dirPath) {
    this.callCounts.list += 1;
    try {
      const names = await fsp.readdir(await this._resolveSafe(dirPath));
      return names.sort();
    } catch (error) {
      const code = codeOf(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return [];
      throw error;
    }
  }

  // Idempotent file removal. A directory argument is EISDIR, matching the
  // memory facade; Windows reports that case as EPERM/EACCES from DeleteFileW,
  // so those are re-classified after confirming the target really is a
  // directory rather than blanket-rewritten (a genuine permission failure must
  // stay a permission failure).
  async remove(filePath) {
    this.callCounts.remove += 1;
    const real = await this._resolveSafe(filePath);
    try {
      await fsp.unlink(real);
    } catch (error) {
      const code = codeOf(error);
      if (code === 'ENOENT') return;
      if (code === 'EISDIR') {
        throw eisdir(`EISDIR: illegal operation on a directory, unlink '${filePath}'`, filePath);
      }
      if (code === 'EPERM' || code === 'EACCES') {
        const stats = await fsp.lstat(real).catch(() => null);
        if (stats && stats.isDirectory()) {
          throw eisdir(`EISDIR: illegal operation on a directory, unlink '${filePath}'`, filePath);
        }
      }
      throw error;
    }
  }

  async removeTree(dirPath) {
    this.callCounts.removeTree += 1;
    const normalized = normalizePath(dirPath);
    if (!normalized) throw new TypeError('removeTree refuses the facade root');
    const real = await this._resolveSafe(normalized);
    await fsp.rm(real, { recursive: true, force: true });
  }

  // Never throws, for any input -- including a path that escapes the root,
  // which resolves to "does not exist" rather than a rejection, because the
  // memory facade's stat cannot throw either and a caller probing a path must
  // get a boolean answer.
  //
  // Uses lstat, not stat: a symlink under the store would otherwise let a
  // stat() answer describe a target OUTSIDE rootDir. A symlink is reported as
  // present-but-neither-file-nor-directory, which makes every store module
  // treat it as unusable and fail closed. The store never creates symlinks, so
  // this costs nothing in the normal case.
  async stat(targetPath) {
    this.callCounts.stat += 1;
    try {
      const stats = await fsp.lstat(await this._resolveSafe(targetPath));
      if (stats.isDirectory()) {
        return { exists: true, isFile: false, isDirectory: true, size: 0 };
      }
      if (!stats.isFile()) {
        return { exists: true, isFile: false, isDirectory: false, size: 0 };
      }
      return { exists: true, isFile: true, isDirectory: false, size: stats.size };
    } catch (_error) {
      return { exists: false, isFile: false, isDirectory: false, size: 0 };
    }
  }
}

// Conformance is asserted at construction rather than trusted: a method added
// to FACADE_METHODS without an implementation here would otherwise surface as
// a TypeError deep inside a commit sequence, mid-mutation.
function assertImplementsFacade(instance) {
  const missing = FACADE_METHODS.filter((name) => typeof instance[name] !== 'function');
  if (missing.length > 0) {
    throw new TypeError(`NodeFsFacade is missing facade methods: ${missing.join(', ')}`);
  }
  return instance;
}

function createNodeFsFacade(options) {
  return assertImplementsFacade(new NodeFsFacade(options));
}

module.exports = {
  NodeFsFacade,
  createNodeFsFacade,
  retryTransientRename,
  resolveUnderRoot,
};
