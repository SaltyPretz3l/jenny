'use strict';

// Files opened in Jenny from outside the Workspace ("Open with Jenny", the
// "File: Open File..." picker; row 137).
//
// Main holds the authority: a grant maps an opaque id to one real file path.
// The renderer only ever sees { id, name, dirLabel, ext } and addresses every
// read, save and action by id, never by path. A file inside the current
// Workspace is not granted at all: it opens as the normal Workspace tab, so
// one file is never open in two buffers.
//
// Requests are queued here and the renderer pulls them (takePending) once its
// shell is bound; the push is only a wake-up, so a cold start loses nothing.

const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fsPromises = require('node:fs/promises');
const nodePath = require('node:path');

const { WORKSPACE_FS_ERROR_CODES } = require('../../backend/error-codes');
const { workspaceFsError } = require('../../workspace-ide-errors');
const { writeJsonAtomicAsync } = require('../../backend/session-storage-fs-utils');
const { VersionedWorkspaceFileService } = require('../../versioned-workspace-file-service');
const {
  DEFAULT_MAX_OUTSIDE_BYTES,
  pathHint,
  readOutsideSnapshot,
  samePath,
  snapshotMetadata,
  writeOutsideFileInPlace,
} = require('./outside-file-io');

const MAX_GRANTS = 64;
const MAX_PENDING_REQUESTS = 32;
const MAX_WATCHED = 32;
const MAX_RESTORED = 20;
const WATCH_DEBOUNCE_MS = 200;
const PERSIST_DELAY_MS = 300;
const RESTORE_FILE = 'outside-files.json';
const RESTORE_VERSION = 1;
const GRANT_ID = /^o[0-9a-f]{24}$/;

function grantUnknown(id) {
  return workspaceFsError(
    WORKSPACE_FS_ERROR_CODES.OUTSIDE_GRANT_UNKNOWN,
    'This file is no longer open in Jenny. Open it again.',
    { reason: GRANT_ID.test(String(id || '')) ? 'expired' : 'invalid' },
  );
}

// Identity, size and mtime of a stat, as one comparable string.
function statKey(stats) {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs].map(String).join(':');
}

function isVolumeRootOrShare(dirPath, platform) {
  const text = String(dirPath || '');
  if (platform === 'win32' && /^\\\\/.test(text)) return true;
  return nodePath.parse(text).root === text;
}

class OutsideFileService {
  constructor({
    fs = fsPromises,
    watch = fsSync.watch,
    platform = process.platform,
    userDataPath = '',
    getWorkspaceRoot = () => null,
    sendBridgeEvent = () => {},
    showItemInFolder = null,
    attachPaths = null,
    pickFiles = null,
    log = () => {},
    maxBytes = DEFAULT_MAX_OUTSIDE_BYTES,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    writeJson = writeJsonAtomicAsync,
  } = {}) {
    this._fs = fs;
    this._watch = watch;
    this._platform = platform;
    this._restorePath = userDataPath ? nodePath.join(userDataPath, RESTORE_FILE) : '';
    this._getWorkspaceRoot = getWorkspaceRoot;
    this._sendBridgeEvent = sendBridgeEvent;
    this._showItemInFolder = showItemInFolder;
    this._attachPaths = attachPaths;
    this._pickFiles = pickFiles;
    this._log = log;
    this._maxBytes = maxBytes;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._writeJson = writeJson;
    this._grants = new Map(); // id -> grant (Map order = least recently used first)
    this._idsByPath = new Map();
    this._openIds = new Set();
    this._pending = [];
    this._watchers = new Map();
    this._locks = new Map();
    this._persistTimer = null;
    this._disposed = false;
  }

  _pathKey(realPath) {
    return this._platform === 'win32' || this._platform === 'darwin' ? realPath.toLowerCase() : realPath;
  }

  _touch(grant) {
    this._grants.delete(grant.id);
    this._grants.set(grant.id, grant);
  }

  _grant(id) {
    const grant = this._grants.get(String(id || ''));
    if (!grant) throw grantUnknown(id);
    this._touch(grant);
    return grant;
  }

  _publicItem(grant) {
    return { kind: 'outside', id: grant.id, name: grant.name, dirLabel: grant.dirLabel, ext: grant.ext };
  }

  _mintGrant(realPath) {
    const key = this._pathKey(realPath);
    const existing = this._idsByPath.get(key);
    if (existing && this._grants.has(existing)) {
      const grant = this._grants.get(existing);
      this._touch(grant);
      return grant;
    }
    const grant = {
      id: `o${crypto.randomBytes(12).toString('hex')}`,
      realPath,
      name: nodePath.basename(realPath),
      dirLabel: nodePath.dirname(realPath),
      ext: nodePath.extname(realPath).replace(/^\./, '').toLowerCase(),
      imageService: null,
    };
    this._grants.set(grant.id, grant);
    this._idsByPath.set(key, grant.id);
    this._evict();
    return grant;
  }

  _evict() {
    for (const grant of this._grants.values()) {
      if (this._grants.size <= MAX_GRANTS) break;
      if (this._openIds.has(grant.id)) continue;
      this._grants.delete(grant.id);
      this._idsByPath.delete(this._pathKey(grant.realPath));
    }
  }

  async _workspaceRelPath(realPath) {
    let root;
    try {
      root = String(this._getWorkspaceRoot() || '');
    } catch (_error) {
      root = '';
    }
    if (!root) return '';
    let realRoot;
    try {
      realRoot = await this._fs.realpath(root);
    } catch (_error) {
      return '';
    }
    const relative = nodePath.relative(realRoot, realPath);
    if (!relative || relative === '..' || relative.startsWith(`..${nodePath.sep}`) || nodePath.isAbsolute(relative)) return '';
    return relative.split(nodePath.sep).join('/');
  }

  async _resolveOne(rawPath) {
    const name = nodePath.basename(String(rawPath || '')).slice(0, 256);
    let realPath;
    let stats;
    try {
      realPath = await this._fs.realpath(String(rawPath));
      stats = await this._fs.stat(realPath);
    } catch (_error) {
      return { failed: { name, code: WORKSPACE_FS_ERROR_CODES.NOT_FOUND } };
    }
    if (!stats.isFile()) return { failed: { name, code: WORKSPACE_FS_ERROR_CODES.NOT_A_FILE } };
    if (stats.size > this._maxBytes) return { failed: { name, code: WORKSPACE_FS_ERROR_CODES.TOO_LARGE } };
    const relPath = await this._workspaceRelPath(realPath);
    if (relPath) return { item: { kind: 'workspace', relPath, name } };
    return { item: this._publicItem(this._mintGrant(realPath)) };
  }

  async intake(paths, source = 'launch') {
    if (this._disposed) return null;
    const list = (Array.isArray(paths) ? paths : []).filter((entry) => typeof entry === 'string' && entry);
    if (!list.length) return null;
    const request = { source: String(source || 'launch'), items: [], failures: [] };
    for (const rawPath of list) {
      const resolved = await this._resolveOne(rawPath);
      if (resolved.failed) {
        if (request.source !== 'restore') request.failures.push(resolved.failed);
        continue;
      }
      // A restored Workspace file comes back with the Workspace's own tabs.
      if (request.source === 'restore' && resolved.item.kind === 'workspace') continue;
      request.items.push(resolved.item);
    }
    if (!request.items.length && !request.failures.length) return null;
    this._log('INFO', 'outside_files.intake', {
      source: request.source,
      opened: request.items.length,
      failed: request.failures.length,
    });
    if (this._pending.length >= MAX_PENDING_REQUESTS) this._pending.shift();
    this._pending.push(request);
    this._sendBridgeEvent('outsideFiles.onRequest', { pending: this._pending.length });
    return request;
  }

  takePending() {
    return { ok: true, requests: this._pending.splice(0, this._pending.length) };
  }

  // The stat Jenny last saw for a grant, with the version it had (from a read or our own save).
  _remember(grant, stats, fileVersion) {
    grant.seen = stats ? { key: statKey(stats), fileVersion: String(fileVersion || '') } : null;
  }

  // A re-check (`ifVersion`: the version the renderer holds) answers `unchanged` from one stat when the file's
  // identity, size and mtime still match what Jenny last saw; otherwise it reads the file as usual.
  async readText(payload = {}) {
    const grant = this._grant(payload.id);
    const ifVersion = String(payload.ifVersion || '');
    if (ifVersion && grant.seen && grant.seen.fileVersion === ifVersion && typeof this._fs.stat === 'function') {
      const stats = await this._fs.stat(grant.realPath).catch(() => null);
      if (stats && statKey(stats) === grant.seen.key) return { id: grant.id, name: grant.name, unchanged: true, fileVersion: ifVersion };
    }
    const snapshot = await readOutsideSnapshot(grant.realPath, { fs: this._fs, maxBytes: this._maxBytes, platform: this._platform });
    this._remember(grant, snapshot.stats, snapshot.fileVersion);
    return { id: grant.id, name: grant.name, ...snapshotMetadata(snapshot, { includeContent: true }) };
  }

  async writeText(payload = {}) {
    const grant = this._grant(payload.id);
    const previous = this._locks.get(grant.id) || Promise.resolve();
    const run = previous.catch(() => {}).then(() => writeOutsideFileInPlace(grant.realPath, {
      content: payload.content,
      expectedFileVersion: payload.expectedFileVersion,
      fs: this._fs,
      maxBytes: this._maxBytes,
      platform: this._platform,
    }));
    this._locks.set(grant.id, run);
    try {
      const { stats, ...result } = await run;
      this._remember(grant, stats, result.fileVersion);
      this._log('INFO', 'outside_files.write', { ...pathHint(grant.realPath), size: result.size });
      return { id: grant.id, ...result };
    } finally {
      if (this._locks.get(grant.id) === run) this._locks.delete(grant.id);
    }
  }

  // Images beside or below the granted file, for the Markdown preview. The
  // fixed-root versioned service refuses anything that resolves outside the
  // file's folder (PATH_OUTSIDE_ROOT) and checks the image allowlist and bytes.
  async readImage(payload = {}) {
    const grant = this._grant(payload.id);
    if (!grant.imageService) {
      const rootPath = grant.dirLabel;
      const rootId = `outside_${grant.id}`;
      const isCurrent = () => this._grants.has(grant.id);
      const context = { phase: 'ready', rootPath, rootId, generation: 1 };
      grant.imageService = new VersionedWorkspaceFileService({
        rootContext: {
          captureContext: () => context,
          isCurrent,
          acquireOperation: async () => ({
            acquired: true,
            operationId: crypto.randomUUID(),
            context,
            signal: new AbortController().signal,
            release: () => {},
            isCurrent,
          }),
        },
      });
    }
    return grant.imageService.readImage({ path: String(payload.relPath || '') });
  }

  setOpenSet(payload = {}) {
    const ids = (Array.isArray(payload.ids) ? payload.ids : []).map(String).filter((id) => this._grants.has(id));
    this._openIds = new Set(ids);
    this._syncWatchers();
    this._schedulePersist();
    return { ok: true, open: this._openIds.size };
  }

  async reveal(payload = {}) {
    const grant = this._grant(payload.id);
    if (typeof this._showItemInFolder !== 'function') {
      throw workspaceFsError(WORKSPACE_FS_ERROR_CODES.REVEAL_UNAVAILABLE, 'Reveal is unavailable.', pathHint(grant.realPath));
    }
    this._showItemInFolder(grant.realPath);
    return { id: grant.id };
  }

  async attach(payload = {}) {
    const grant = this._grant(payload.id);
    if (typeof this._attachPaths !== 'function') return { ok: false, accepted: [], rejected: [] };
    const result = await this._attachPaths([grant.realPath], { session_id: String(payload.session_id || '') });
    return { ok: true, ...(result && typeof result === 'object' ? result : {}) };
  }

  async pick() {
    if (typeof this._pickFiles !== 'function') return { ok: false, opened: 0 };
    const paths = await this._pickFiles();
    const request = await this.intake(paths, 'picker');
    return { ok: true, opened: request ? request.items.length : 0 };
  }

  async restore() {
    if (!this._restorePath) return null;
    let parsed;
    try {
      parsed = JSON.parse(await this._fs.readFile(this._restorePath, 'utf8'));
    } catch (_error) {
      return null;
    }
    if (!parsed || parsed.version !== RESTORE_VERSION || !Array.isArray(parsed.paths)) return null;
    const paths = parsed.paths.filter((entry) => typeof entry === 'string' && nodePath.isAbsolute(entry)).slice(0, MAX_RESTORED);
    return this.intake(paths, 'restore');
  }

  _schedulePersist() {
    if (!this._restorePath || this._disposed) return;
    if (this._persistTimer) this._clearTimer(this._persistTimer);
    this._persistTimer = this._setTimer(() => {
      this._persistTimer = null;
      void this._persistNow();
    }, PERSIST_DELAY_MS);
    this._persistTimer?.unref?.();
  }

  async _persistNow() {
    const paths = [...this._openIds]
      .map((id) => this._grants.get(id)?.realPath)
      .filter(Boolean)
      .slice(0, MAX_RESTORED);
    try {
      await this._writeJson(this._restorePath, { version: RESTORE_VERSION, paths });
    } catch (error) {
      this._log('WARN', 'outside_files.persist_failed', { os_code: String(error?.code || 'unknown') });
    }
  }

  _syncWatchers() {
    for (const [id, entry] of this._watchers) {
      if (this._openIds.has(id)) continue;
      this._closeWatcher(id, entry);
    }
    for (const id of this._openIds) {
      if (this._watchers.has(id) || this._watchers.size >= MAX_WATCHED) continue;
      const grant = this._grants.get(id);
      // Watching a drive root keeps a handle that blocks safe eject, and SMB
      // shares may not deliver events: those files rely on the renderer's
      // re-check when the window regains focus.
      if (!grant || isVolumeRootOrShare(grant.dirLabel, this._platform)) continue;
      this._openWatcher(grant);
    }
  }

  _openWatcher(grant) {
    const entry = { watcher: null, timer: null };
    try {
      entry.watcher = this._watch(grant.dirLabel, { persistent: false }, (_event, fileName) => {
        if (fileName && !samePath(String(fileName), grant.name, this._platform)) return;
        if (entry.timer) this._clearTimer(entry.timer);
        entry.timer = this._setTimer(() => {
          entry.timer = null;
          void this._emitChange(grant);
        }, WATCH_DEBOUNCE_MS);
      });
      entry.watcher.on?.('error', () => this._closeWatcher(grant.id, entry));
      this._watchers.set(grant.id, entry);
    } catch (error) {
      this._log('WARN', 'outside_files.watch_failed', { ...pathHint(grant.realPath), os_code: String(error?.code || 'unknown') });
    }
  }

  _closeWatcher(id, entry) {
    if (entry.timer) this._clearTimer(entry.timer);
    try { entry.watcher?.close?.(); } catch (_error) { /* best effort */ }
    this._watchers.delete(id);
  }

  async _emitChange(grant) {
    if (this._disposed || !this._openIds.has(grant.id)) return;
    let kind = 'changed';
    try {
      await this._fs.stat(grant.realPath);
    } catch (_error) {
      kind = 'deleted';
    }
    this._sendBridgeEvent('outsideFiles.onChange', { id: grant.id, kind });
  }

  dispose() {
    this._disposed = true;
    if (this._persistTimer) this._clearTimer(this._persistTimer);
    for (const [id, entry] of this._watchers) this._closeWatcher(id, entry);
  }
}

module.exports = {
  MAX_GRANTS,
  MAX_RESTORED,
  OutsideFileService,
  RESTORE_FILE,
  isVolumeRootOrShare,
};
