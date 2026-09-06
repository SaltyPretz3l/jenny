'use strict';

// The Stage 3A storage core never touches `node:fs` directly (lane contract,
// PLUG-D22). Every store module receives this facade as a constructor/function
// parameter instead. That is what lets Stage 2's tests run with no real disk,
// and it is the seam W4 hangs a crash-injecting implementation off of: because
// every durability primitive below is exposed separately (not folded into one
// opaque "atomic write" call), a wrapping facade can fail/delay/reorder any
// single step -- write the temp bytes but never fsync them, fsync but never
// rename, rename but never fsync the directory, etc. -- and prove the store
// modules built on top only ever observe the fully-old or fully-new state.
//
// Facet coverage (fs-facade interface, per the packet brief): read, write
// (single-shot "write-atomic" whole-file content, never partial/streaming),
// rename, fsync (both file- and directory-scoped, since Windows cannot fsync a
// directory the way POSIX can -- see PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md
// "Windows directory fsync limitations are treated as a recovery concern"),
// list, remove, stat. `mkdir` is an addition beyond that named list: every
// store module needs to materialize a generation/operation/package directory
// before it can write into it, and a real disk-backed facade (Stage 3B) will
// need the same primitive, so it is part of the interface rather than assumed.
//
// A facade implementation MUST expose exactly these async methods:
//   readFile(path, encoding='utf8') -> Promise<string|Buffer>
//                                                    `encoding:null` preserves exact bytes;
//                                                    rejects {code:'ENOENT'} if missing
//   writeFile(path, contents) -> Promise<void>         whole-file string/Buffer write;
//                                                    parent dir must exist
//   fsyncFile(path) -> Promise<void>                   durability barrier; path must exist
//   renameFile(oldPath, newPath) -> Promise<void>       atomic same-volume replace
//   fsyncDir(dirPath) -> Promise<void>                 best-effort; NEVER throws (see above)
//   list(dirPath) -> Promise<string[]>                 immediate child names; [] if absent
//   remove(path) -> Promise<void>                      idempotent; resolves if already absent
//   removeTree(dirPath) -> Promise<void>               recursive/idempotent; refuses facade root
//   stat(path) -> Promise<{exists,isFile,isDirectory,size}>  never throws
//   mkdir(dirPath) -> Promise<void>                    recursive, idempotent
//
// Paths are logical, POSIX-style strings rooted at whatever `baseDir` a caller
// chooses (there is no real filesystem underneath in Stage 2). Use joinPath()
// below to build them so separator handling stays uniform.

const path = require('node:path');

const FACADE_METHODS = Object.freeze([
  'readFile',
  'writeFile',
  'fsyncFile',
  'renameFile',
  'fsyncDir',
  'list',
  'remove',
  'removeTree',
  'stat',
  'mkdir',
]);

function joinPath(...parts) {
  const joined = path.posix.join(...parts.map((part) => String(part)));
  return normalizePath(joined);
}

function normalizePath(rawPath) {
  const normalized = path.posix.normalize(String(rawPath || '').replace(/\\/g, '/'));
  const stripped = normalized.replace(/^\/+/, '').replace(/\/+$/, '');
  return stripped === '.' ? '' : stripped;
}

function parentOf(normalizedPath) {
  if (!normalizedPath) return '';
  const dirname = path.posix.dirname(normalizedPath);
  return dirname === '.' ? '' : dirname;
}

function baseNameOf(normalizedPath) {
  return path.posix.basename(normalizedPath);
}

function enoent(message, targetPath) {
  const error = new Error(message);
  error.code = 'ENOENT';
  error.path = targetPath;
  return error;
}

// Implements the facade contract entirely in memory: a flat map of normalized
// path -> file contents, plus an explicit set of known directories. Mirrors
// real POSIX semantics closely enough to exercise store-module logic (missing
// parent directories reject writes; rename requires an existing source and an
// existing destination directory; a duplicate rename target is silently
// replaced) without any of Stage 3B's real disk-adapter concerns.
class MemoryFsFacade {
  constructor() {
    this._files = new Map();
    this._dirs = new Set(['']);
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
  }

  async mkdir(dirPath) {
    this.callCounts.mkdir += 1;
    const normalized = normalizePath(dirPath);
    let cursor = normalized;
    const chain = [];
    while (cursor && !this._dirs.has(cursor)) {
      chain.push(cursor);
      cursor = parentOf(cursor);
    }
    for (let i = chain.length - 1; i >= 0; i -= 1) {
      this._dirs.add(chain[i]);
    }
    this._dirs.add(normalized);
  }

  async writeFile(filePath, contents) {
    this.callCounts.writeFile += 1;
    const normalized = normalizePath(filePath);
    const dir = parentOf(normalized);
    if (!this._dirs.has(dir)) {
      throw enoent(`ENOENT: parent directory does not exist, open '${filePath}'`, filePath);
    }
    this._files.set(normalized, Buffer.isBuffer(contents) ? Buffer.from(contents) : String(contents));
  }

  async readFile(filePath, encoding = 'utf8') {
    this.callCounts.readFile += 1;
    const normalized = normalizePath(filePath);
    if (!this._files.has(normalized)) {
      throw enoent(`ENOENT: no such file, open '${filePath}'`, filePath);
    }
    const contents = this._files.get(normalized);
    if (encoding === null) {
      return Buffer.isBuffer(contents) ? Buffer.from(contents) : Buffer.from(contents, 'utf8');
    }
    return Buffer.isBuffer(contents) ? contents.toString(encoding) : contents;
  }

  async fsyncFile(filePath) {
    this.callCounts.fsyncFile += 1;
    const normalized = normalizePath(filePath);
    if (!this._files.has(normalized)) {
      throw enoent(`ENOENT: no such file, fsync '${filePath}'`, filePath);
    }
  }

  async renameFile(oldPath, newPath) {
    this.callCounts.renameFile += 1;
    const normalizedOld = normalizePath(oldPath);
    const normalizedNew = normalizePath(newPath);
    if (!this._files.has(normalizedOld)) {
      throw enoent(`ENOENT: no such file, rename '${oldPath}' -> '${newPath}'`, oldPath);
    }
    const destDir = parentOf(normalizedNew);
    if (!this._dirs.has(destDir)) {
      throw enoent(`ENOENT: destination directory does not exist, rename '${oldPath}' -> '${newPath}'`, newPath);
    }
    this._files.set(normalizedNew, this._files.get(normalizedOld));
    this._files.delete(normalizedOld);
  }

  // Best-effort by contract: real Windows directory fsync is itself limited,
  // so callers may never treat this as a durability guarantee on its own.
  // It never throws, even for an unknown directory.
  async fsyncDir(_dirPath) {
    this.callCounts.fsyncDir += 1;
  }

  async list(dirPath) {
    this.callCounts.list += 1;
    const normalized = normalizePath(dirPath);
    if (normalized && !this._dirs.has(normalized)) {
      return [];
    }
    const names = new Set();
    const prefix = normalized ? `${normalized}/` : '';
    for (const dir of this._dirs) {
      if (dir === normalized || !dir.startsWith(prefix)) continue;
      const rest = dir.slice(prefix.length);
      const firstSegment = rest.split('/')[0];
      if (firstSegment) names.add(firstSegment);
    }
    for (const filePath of this._files.keys()) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const firstSegment = rest.split('/')[0];
      if (firstSegment) names.add(firstSegment);
    }
    return Array.from(names).sort();
  }

  async remove(filePath) {
    this.callCounts.remove += 1;
    const normalized = normalizePath(filePath);
    if (this._dirs.has(normalized)) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, unlink '${filePath}'`), {
        code: 'EISDIR',
        path: filePath,
      });
    }
    this._files.delete(normalized);
  }

  async removeTree(dirPath) {
    this.callCounts.removeTree += 1;
    const normalized = normalizePath(dirPath);
    if (!normalized) throw new TypeError('removeTree refuses the facade root');
    const prefix = `${normalized}/`;
    for (const filePath of this._files.keys()) {
      if (filePath.startsWith(prefix)) this._files.delete(filePath);
    }
    for (const directory of Array.from(this._dirs)) {
      if (directory === normalized || directory.startsWith(prefix)) this._dirs.delete(directory);
    }
  }

  async stat(targetPath) {
    this.callCounts.stat += 1;
    const normalized = normalizePath(targetPath);
    if (this._files.has(normalized)) {
      const contents = this._files.get(normalized);
      return { exists: true, isFile: true, isDirectory: false, size: Buffer.byteLength(contents, 'utf8') };
    }
    if (this._dirs.has(normalized)) {
      return { exists: true, isFile: false, isDirectory: true, size: 0 };
    }
    return { exists: false, isFile: false, isDirectory: false, size: 0 };
  }
}

function createMemoryFsFacade() {
  return new MemoryFsFacade();
}

module.exports = {
  FACADE_METHODS,
  MemoryFsFacade,
  createMemoryFsFacade,
  joinPath,
  normalizePath,
  parentOf,
  baseNameOf,
};
