'use strict';

// Team boards T1 (row 151, plan PROJECT_BOARD_2026-11-13 section 8.1): the host board store's paths and guarded file
// access. IO and path rules only; what a file says is board-host-store.js's business.
//
//   <profile>/team-boards/<project_id>/index.json
//   <profile>/team-boards/<project_id>/<board_id>.json | <board_id>.journal.json | <board_id>.proposals.json
//   <profile>/team-boards/<project_id>/assets/<sha256>.<ext> | assets/unreferenced.json   the pictures (slice T6)
//
// - Ids pass services/boards/board-ids.js before a path is formed, and a formed path must stay one entry under its
//   folder. project_general never has a folder here.
// - A project folder is found in the real listing of team-boards by its exact name. A name that differs only by
//   letter case (the same folder on Windows and macOS) is `clash`: never this project's folder, never written.
// - Every path passes the injected guard (services/host/path-guard.js assertSafeFile by default) before it is read,
//   written or removed. A link at team-boards, at a project folder or at a file is never followed.
// - A write is serialized once by the caller (`serialize`), refused over its cap before the disk is touched, and
//   lands through temp file, fsync, rename (services/host/durable-json.js writeText).
// - A transient error (a Windows lock: EPERM, EBUSY) is reported as `transient`; the store answers unavailable and
//   never latches. Removal goes through services/fs-remove-no-follow.js and never enters a link.
// - Slice T6, the assets folder: made one level inside a project folder that already exists (never the project
//   folder itself); a picture is read only from a regular single-name file through O_NOFOLLOW, and written through
//   a temp file, fsync and rename (durable-json.js readBytes and writeBytes). A link or a hard-linked file at a
//   picture is never read, written or removed.

const fs = require('node:fs');
const path = require('node:path');

const ids = require('../../../services/boards/board-ids');
const { removeFileSync, removeTree } = require('../../../services/fs-remove-no-follow');
const durable = require('../../../services/host/durable-json');
const { INDEX_FILE_BYTES } = require('./board-host-index');

const { logCode } = durable;

const BOARDS_ROOT = 'team-boards';
const ASSETS_DIR = 'assets';
const GUARD_PROBE = '.guard-probe';
// The name services/host/durable-json.js gives the temp file of a write.
const TEMP_FILE_RE = /^\.host-[0-9a-f]{32}\.tmp$/u;
// Read and write caps (bytes) of each file kind.
const FILE_CAPS = Object.freeze({
  document: 4 * 1024 * 1024,
  journal: 2 * 1024 * 1024,
  proposals: 1024 * 1024,
  index: INDEX_FILE_BYTES,
});
const LIST_MAX = 4096;
const ASSET_LIST_MAX = 50000;
const TRANSIENT_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE', 'ENFILE', 'EIO', 'EAGAIN']);
const isTransient = (error) => TRANSIENT_CODES.has(error?.code) || error?.message === 'metadata_changed_during_read';

const isTeamProjectId = (value) => ids.isProjectId(value) && value !== ids.GENERAL_PROJECT_ID;

function createBoardFiles({ root, guard, ops, log }) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new TypeError('createBoardFiles requires an absolute root.');
  if (typeof guard !== 'function') throw new TypeError('createBoardFiles requires a path guard.');

  // One entry directly under `parent`, or null.
  function child(parent, name) {
    const joined = path.join(parent, name);
    const relative = path.relative(parent, joined);
    return relative === name && !path.isAbsolute(relative) ? joined : null;
  }

  function projectDir(projectId) {
    return isTeamProjectId(projectId) ? child(root, projectId) : null;
  }

  function boardPath(projectId, boardId, kind) {
    const dir = projectDir(projectId);
    if (!dir || !ids.isBoardId(boardId) || !Object.hasOwn(ids.FILE_SUFFIXES, kind)) return null;
    return child(dir, `${boardId}${ids.FILE_SUFFIXES[kind]}`);
  }

  const indexPath = (projectId) => {
    const dir = projectDir(projectId);
    return dir ? child(dir, ids.INDEX_FILE) : null;
  };

  function lstatOrNull(target) {
    try { return fs.lstatSync(target); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  }

  // A plain directory reached without a link, by the guard's own rule.
  function plainDirectory(dir) {
    const stat = lstatOrNull(dir);
    if (!stat) return 'missing';
    if (stat.isSymbolicLink() || !stat.isDirectory()) return 'unsafe';
    try { guard(path.join(dir, GUARD_PROBE)); } catch { return 'unsafe'; }
    return 'ok';
  }

  const failedState = (error) => (isTransient(error) ? 'transient' : 'unsafe');

  /** 'ok' | 'missing' | 'unsafe' | 'transient' for team-boards itself. */
  function rootState() {
    try { return plainDirectory(root); } catch (error) { return failedState(error); }
  }

  /** 'ok' | 'missing' | 'clash' | 'unsafe' | 'transient' | 'invalid' for one project's folder. */
  function projectState(projectId) {
    const dir = projectDir(projectId);
    if (!dir) return 'invalid';
    const state = rootState();
    if (state !== 'ok') return state;
    try {
      const names = ops.listDir(root);
      if (!names.includes(projectId)) {
        const folded = projectId.toLowerCase();
        return names.some((name) => name.toLowerCase() === folded) ? 'clash' : 'missing';
      }
      return plainDirectory(dir);
    } catch (error) {
      return failedState(error);
    }
  }

  /**
   * { status, value }: status 'ok' | 'missing' | 'too_large' | 'corrupt' | 'link' | 'transient'. The file is
   * size-checked by lstat before it is opened and parsed; content is untrusted (the caller validates it).
   */
  function read(filePath, maxBytes) {
    let stat;
    try {
      stat = lstatOrNull(filePath);
    } catch (error) {
      return { status: isTransient(error) ? 'transient' : 'corrupt', value: null };
    }
    if (!stat) return { status: 'missing', value: null };
    if (stat.isSymbolicLink()) return { status: 'link', value: null };
    if (!stat.isFile()) return { status: 'corrupt', value: null };
    if (stat.size > maxBytes) return { status: 'too_large', value: null };
    try { guard(filePath); } catch { return { status: 'link', value: null }; }
    try {
      const value = ops.readJson(filePath, { maxBytes });
      return value === null ? { status: 'missing', value: null } : { status: 'ok', value };
    } catch (error) {
      return { status: isTransient(error) ? 'transient' : 'corrupt', value: null };
    }
  }

  /** The text of `value` and its UTF-8 bytes, computed once; null when it cannot be serialized. */
  function serialize(value) {
    try {
      const text = JSON.stringify(value);
      return typeof text === 'string' ? { text, bytes: Buffer.byteLength(text, 'utf8') } : null;
    } catch {
      return null;
    }
  }

  function ensureDirectory(dir) {
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
    if (plainDirectory(dir) !== 'ok') throw Object.assign(new Error('unsafe_directory'), { code: 'EUNSAFE' });
  }

  /**
   * Writes one serialized file of a project folder, creating team-boards and the folder when missing (never the
   * profile itself: a profile that is gone is a failed write). Throws an error with `overCap: true` before touching
   * the disk when it is over `maxBytes`; any other failure throws with `duringWrite: true` (the file may or may not
   * have landed).
   */
  function write(filePath, serialized, maxBytes) {
    if (!serialized || serialized.bytes > maxBytes) throw Object.assign(new Error('over_cap'), { overCap: true });
    try {
      const dir = path.dirname(filePath);
      if (path.dirname(dir) !== root || child(root, path.basename(dir)) !== dir) throw new Error('outside_root');
      ensureDirectory(root);
      ensureDirectory(dir);
      guard(filePath);
      ops.writeText(filePath, serialized.text);
      return serialized.bytes;
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error('write_failed'), { duringWrite: true });
    }
  }

  /** The size of a plain file, 0 when it is absent; null when it cannot be told (a link, a lock). */
  function sizeOf(filePath) {
    try {
      const stat = lstatOrNull(filePath);
      if (!stat) return 0;
      return stat.isFile() && !stat.isSymbolicLink() ? stat.size : null;
    } catch {
      return null;
    }
  }

  const exists = (filePath) => {
    try { return lstatOrNull(filePath) !== null; } catch { return true; }
  };

  /** The project folder names under team-boards (at most LIST_MAX), or null when team-boards is not usable. */
  function listProjects() {
    const state = rootState();
    if (state === 'missing') return [];
    if (state !== 'ok') return null;
    try {
      return ops.listDir(root).filter(isTeamProjectId).sort().slice(0, LIST_MAX);
    } catch {
      return null;
    }
  }

  /** Removes one board file without following a link; true when it is gone. */
  function removeFile(filePath, projectId) {
    try {
      if (exists(filePath)) {
        guard(filePath);
        removeFileSync(filePath);
      }
      return true;
    } catch (error) {
      log('WARN', 'team_board.file_remove_failed', { project_id: projectId, code: logCode(error?.code) });
      return false;
    }
  }

  /**
   * Removes the temp files a crash in the middle of a write left in a project's folder and in its assets folder:
   * plain files by the writer's temp name, last written before `olderThanMs` (a write in progress is younger). A
   * link is never followed or removed. Answers how many went; one that cannot be removed waits for the next call.
   */
  function removeStaleTemps(projectId, olderThanMs) {
    let removed = 0;
    for (const [dir, state] of [[projectDir(projectId), projectState(projectId)], [assetsDir(projectId), assetsState(projectId)]]) {
      if (state !== 'ok') continue;
      let names;
      try { names = ops.listDir(dir).filter((name) => TEMP_FILE_RE.test(name)); } catch { continue; }
      for (const name of names) {
        const filePath = path.join(dir, name);
        try {
          const stat = lstatOrNull(filePath);
          if (!stat || stat.isSymbolicLink() || !stat.isFile() || !(stat.mtimeMs < olderThanMs)) continue;
          guard(filePath);
          removeFileSync(filePath);
          removed += 1;
        } catch { /* kept for the next call */ }
      }
    }
    return removed;
  }

  /**
   * Removes a project's folder and everything in it, `assets` included, without entering a link (a link at the
   * folder is unlinked). 'gone' when it is gone or was never there (a folder whose name differs only by case is
   * another project's and is left), else 'failed'. team-boards itself must be a plain directory first: a removal
   * under a link would land in the link's target.
   */
  async function removeProjectDir(projectId) {
    const dir = projectDir(projectId);
    if (!dir) return 'gone';
    const state = projectState(projectId);
    if (state === 'missing' || state === 'clash') return 'gone';
    if (rootState() !== 'ok') return 'failed';
    try {
      await removeTree(dir);
      return lstatOrNull(dir) === null ? 'gone' : 'failed';
    } catch (error) {
      log('WARN', 'team_board.project_remove_failed', { project_id: projectId, code: logCode(error?.code) });
      return 'failed';
    }
  }

  /**
   * Every board id with a document entry in the project folder (a link counts: it is shown read-only), sorted, or
   * null when the folder holds more than LIST_MAX entries. The one listing: a cut listing would read as "those
   * documents are gone", so past the bound the caller answers unavailable instead (the store's entry cap keeps a
   * folder it wrote itself far under it). Throws when the folder cannot be read.
   */
  function listAllBoardIds(projectId) {
    const entries = fs.readdirSync(projectDir(projectId), { withFileTypes: true });
    if (entries.length > LIST_MAX) return null;
    const found = [];
    for (const entry of entries) {
      const parsed = ids.parseBoardFileName(entry.name);
      if (parsed && parsed.kind === 'document' && (entry.isFile() || entry.isSymbolicLink())) found.push(parsed.id);
    }
    return found.sort();
  }

  /* -------------------------------------------------------------- assets (slice T6) */

  const assetIo = { read: ops.readBytes || ((filePath, maxBytes) => durable.readBytes(filePath, { maxBytes })),
    write: ops.writeBytes || durable.writeBytes };

  function assetsDir(projectId) {
    const dir = projectDir(projectId);
    return dir ? child(dir, ASSETS_DIR) : null;
  }

  /** The path of a picture (`<sha256>.<ext>`) or of the clocks file in a project's assets folder, or null. */
  function assetPath(projectId, name) {
    const dir = assetsDir(projectId);
    return dir && ids.isBoardAssetFileName(name) ? child(dir, name) : null;
  }

  /** 'ok' | 'missing' (no assets folder yet) | 'no_project' | 'invalid' | 'unsafe' | 'transient'. */
  function assetsState(projectId) {
    const state = projectState(projectId);
    if (state === 'missing' || state === 'clash') return 'no_project';
    if (state !== 'ok') return state;
    try { return plainDirectory(assetsDir(projectId)); } catch (error) { return failedState(error); }
  }

  /** 'missing' | 'plain' (a regular single-name file the guard accepts) | 'unsafe' | 'transient' for one asset path. */
  function assetEntry(filePath) {
    if (!filePath) return 'unsafe';
    let stat;
    try { stat = lstatOrNull(filePath); } catch (error) { return failedState(error); }
    if (!stat) return 'missing';
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) return 'unsafe';
    try { guard(filePath); } catch { return 'unsafe'; }
    return 'plain';
  }

  /** { status: 'ok' | 'missing' | 'link' | 'corrupt' | 'too_large' | 'transient', bytes } of one picture file. */
  function readAsset(filePath, maxBytes) {
    const none = (status) => ({ status, bytes: null });
    if (!filePath) return none('corrupt');
    let stat;
    try { stat = lstatOrNull(filePath); } catch (error) { return none(isTransient(error) ? 'transient' : 'corrupt'); }
    if (!stat) return none('missing');
    if (stat.isSymbolicLink()) return none('link');
    if (!stat.isFile()) return none('corrupt');
    if (stat.nlink !== 1) return none('link');
    if (stat.size > maxBytes) return none('too_large');
    try { guard(filePath); } catch { return none('link'); }
    try {
      const bytes = assetIo.read(filePath, maxBytes);
      return bytes === null ? none('missing') : { status: 'ok', bytes };
    } catch (error) {
      return none(isTransient(error) ? 'transient' : 'corrupt');
    }
  }

  /**
   * Writes one file of a project's assets folder. The folder is made one level inside a project folder that exists;
   * a missing project folder is a failed write, never recreated. Throws with `duringWrite: true` on any failure.
   */
  function writeAsset(projectId, name, bytes) {
    const filePath = assetPath(projectId, name);
    try {
      if (!filePath) throw new Error('outside_root');
      if (projectState(projectId) !== 'ok') throw Object.assign(new Error('project_missing'), { code: 'ENOENT' });
      ensureDirectory(assetsDir(projectId));
      guard(filePath);
      assetIo.write(filePath, bytes);
      return bytes.byteLength;
    } catch (error) {
      throw Object.assign(error instanceof Error ? error : new Error('write_failed'), { duringWrite: true });
    }
  }

  /**
   * The pictures of a project's assets folder: [{ name, hash, ext, bytes }] for regular files by their picture name
   * (a link is skipped); [] when there is no folder; null when the folder is unsafe or cannot be listed whole.
   */
  function listAssets(projectId) {
    const state = assetsState(projectId);
    if (state === 'missing' || state === 'no_project') return [];
    if (state !== 'ok') return null;
    const dir = assetsDir(projectId);
    try {
      const names = ops.listDir(dir);
      if (names.length > ASSET_LIST_MAX) return null;
      const found = [];
      for (const name of names) {
        const parsed = ids.parseAssetFileName(name);
        const stat = parsed ? lstatOrNull(path.join(dir, name)) : null;
        if (stat && stat.isFile() && !stat.isSymbolicLink()) found.push({ name, hash: parsed.asset, ext: parsed.ext, bytes: stat.size });
      }
      return found;
    } catch {
      return null;
    }
  }

  return Object.freeze({
    root, projectDir, boardPath, indexPath, rootState, projectState, read, serialize, write, sizeOf, exists,
    listProjects, removeFile, removeStaleTemps, removeProjectDir, isTransient,
    listAllBoardIds, assetsDir, assetPath, assetsState, assetEntry, readAsset, writeAsset, listAssets,
  });
}

module.exports = { ASSETS_DIR, BOARDS_ROOT, FILE_CAPS, createBoardFiles, isTeamProjectId };
