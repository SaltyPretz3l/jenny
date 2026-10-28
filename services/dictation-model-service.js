'use strict';

// Opt-in, resumable download of the pinned dictation speech model (row 84).
// Files land in `<userData>/engines/speech/.staging-<id>/` as `.part` files that
// survive cancel and network failure (the next setup resumes with an HTTP Range
// request); each finished file is sha256-verified and renamed in place. Only when
// every file is verified is install.json written, last, and the staging directory
// renamed to `<userData>/engines/speech/<id>/`. Startup detection trusts
// install.json plus exact byte sizes and never re-hashes the model.
// Logs carry event names and reason codes only, never URLs or paths.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { removeFile, removeTree } = require('./fs-remove-no-follow');
const { resolveHuggingFaceAssetUrl } = require('./ninfer-artifact-download');
const { isHuggingFaceDownloadHost } = require('./ninfer-manifests');
const {
  DICTATION_MODEL_MANIFEST, dictationFileRelativePath, dictationFileUrl,
} = require('./dictation-model-manifest');

const DISK_HEADROOM_BYTES = 64 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 250;
const PARTIAL_SUFFIX = '.part';
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/;
const REASON = /^[a-z][a-z0-9_]{0,79}$/;
const INSTALL_FILE = 'install.json';
const SUBDIR = /^[a-z][a-z0-9_-]{0,31}$/;
const REPO_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

const failure = (reason) => Object.assign(new Error(reason), { reason });

function reasonOf(error) {
  if (typeof error?.reason === 'string' && REASON.test(error.reason)) return error.reason;
  if (typeof error?.code === 'string' && REASON.test(error.code)) return error.code;
  return 'download_failed';
}

function validateManifest(manifest) {
  const ok = manifest && typeof manifest.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(manifest.id)
    && Array.isArray(manifest.files) && manifest.files.length > 0
    && manifest.files.every((entry) => entry && SUBDIR.test(entry.subdir) && REPO_FILE.test(entry.repoPath)
      && Number.isInteger(entry.bytes) && entry.bytes > 0 && /^[0-9a-f]{64}$/.test(entry.sha256)
      && typeof entry.repo === 'string' && typeof entry.revision === 'string');
  if (!ok) throw new TypeError('Invalid dictation model manifest.');
  return manifest;
}

class DictationModelService extends EventEmitter {
  constructor({ userDataPath, manifest = DICTATION_MODEL_MANIFEST, fetchImpl = globalThis.fetch,
    statfsImpl = fs.promises.statfs, now = Date.now, logger = null,
    responseStartTimeoutMs = 30_000, inactivityMs = 60_000 }) {
    super();
    this.manifest = validateManifest(manifest);
    this.files = this.manifest.files.map((entry) => ({ ...entry, relative: dictationFileRelativePath(entry) }));
    this.totalBytes = this.files.reduce((sum, entry) => sum + entry.bytes, 0); // test manifests carry no total
    Object.assign(this, { fetchImpl, statfsImpl, now, logger, responseStartTimeoutMs, inactivityMs });
    this.root = path.join(path.resolve(userDataPath), 'engines', 'speech');
    this.finalDir = path.join(this.root, this.manifest.id);
    this.stagingDir = path.join(this.root, `.staging-${this.manifest.id}`);
    this.state = 'not_installed';
    this.downloadedBytes = 0;
    this.error = null;
    this.operation = null;
    this.lastProgressEmit = -Infinity;
    this.detection = null;
    this.disposed = false;
  }

  getState() {
    return {
      state: this.state,
      downloadedBytes: this.downloadedBytes,
      totalBytes: this.totalBytes,
      modelDir: this.state === 'ready' ? this.finalDir : null,
      error: this.error ? { ...this.error } : null,
    };
  }

  // What the renderer sees (IPC results and change events): never the model path.
  getPublicState() {
    const { modelDir: _modelDir, ...rest } = this.getState();
    return rest;
  }

  // Resolves once startup detection has run (memoized); never rejects.
  start() {
    if (!this.detection) {
      this.detection = this._detect().catch(() => { /* an unreadable root reads as not installed */ });
    }
    return this.detection;
  }

  async _detect() {
    if (await this._isInstalled()) this._set({ state: 'ready', downloadedBytes: this.totalBytes, error: null });
  }

  // install.json matches the manifest and every file has its exact size; the
  // hash was checked at install time and is not recomputed here.
  async _isInstalled() {
    try {
      const record = JSON.parse(await fs.promises.readFile(path.join(this.finalDir, INSTALL_FILE), 'utf8'));
      if (!this._recordMatches(record)) return false;
      for (const entry of this.files) {
        const stat = await fs.promises.lstat(path.join(this.finalDir, ...entry.relative.split('/')));
        if (!stat.isFile() || stat.size !== entry.bytes) return false;
      }
      return true;
    } catch (_error) {
      return false;
    }
  }

  _recordMatches(record) {
    if (!record || record.id !== this.manifest.id || !Array.isArray(record.files)
      || record.files.length !== this.files.length) return false;
    return this.files.every((entry) => record.files.some((item) => item?.path === entry.relative
      && item.bytes === entry.bytes && item.sha256 === entry.sha256));
  }

  _set(patch) {
    Object.assign(this, patch);
    this._emit();
  }

  // Starts or resumes the download in the background; resolves with the state.
  async setup() {
    if (this.disposed) return this.getState();
    await this.start();
    // A cancelled run is still unwinding: let it finish before a new one claims the files.
    if (this.operation?.cancelled) await this.operation.done;
    if (this.operation || this.state === 'ready') return this.getState();
    const op = { cancelled: false, abortController: new AbortController(), phase: 'start' };
    this.operation = op;
    this.lastProgressEmit = -Infinity;
    this._set({ state: 'downloading', error: null });
    op.done = this._run(op).finally(() => { if (this.operation === op) this.operation = null; });
    return this.getState();
  }

  // Resolves when the current run (if any) has fully unwound; for tests and shutdown.
  async whenIdle() {
    while (this.operation) await this.operation.done.catch(() => {});
  }

  async _run(op) {
    try {
      await this._download(op);
      this._log('INFO', 'dictation_model.install_finished', {});
      this._set({ state: 'ready', downloadedBytes: this.totalBytes, error: null });
    } catch (error) {
      if (op.cancelled) {
        this._log('INFO', 'dictation_model.download_cancelled', { phase: op.phase });
        // A file finishing mid-cancel may have set downloading or verifying again.
        if (!this.disposed && this.state !== 'not_installed') this._set({ state: 'not_installed', error: null });
        return;
      }
      const reason = reasonOf(error);
      this._log('WARN', 'dictation_model.download_failed', { phase: op.phase, reason });
      // The renderer words the reason (Settings and the composer popover).
      this._set({ state: 'failed', error: { reason } });
    }
  }

  async _download(op) {
    op.phase = 'prepare';
    await this._assertPlain([this.root, this.stagingDir]);
    await fs.promises.mkdir(this.stagingDir, { recursive: true });
    const sizes = [];
    let remaining = 0;
    for (const entry of this.files) {
      const final = this._stagedPath(entry);
      let done = await this._fileSize(final);
      if (done !== 0 && done !== entry.bytes) { await removeFile(final); done = 0; }
      let partial = 0;
      if (done === 0) {
        partial = await this._fileSize(`${final}${PARTIAL_SUFFIX}`);
        if (partial > entry.bytes) { await removeFile(`${final}${PARTIAL_SUFFIX}`); partial = 0; }
      }
      sizes.push({ entry, complete: done === entry.bytes, partial });
      remaining += entry.bytes - (done === entry.bytes ? entry.bytes : partial);
    }
    op.phase = 'disk_check';
    let free = null;
    try { free = await this._freeBytes(); } catch (_error) { this._log('WARN', 'dictation_model.disk_check_skipped', {}); }
    if (free !== null && Number.isFinite(free) && free < remaining + DISK_HEADROOM_BYTES) {
      throw failure('insufficient_disk_space');
    }
    this._set({ downloadedBytes: sizes.reduce((sum, item) => sum + (item.complete ? item.entry.bytes : item.partial), 0) });
    for (const item of sizes) {
      this._checkCancelled(op);
      if (!item.complete) await this._fetchFile(item.entry, item.partial, op);
    }
    op.phase = 'promote';
    this._set({ state: 'verifying' });
    await this._promote(op);
  }

  // Downloads one file to its .part, verifies the hash and renames it into place.
  async _fetchFile(entry, partialBytes, op) {
    const final = this._stagedPath(entry);
    const partial = `${final}${PARTIAL_SUFFIX}`;
    await fs.promises.mkdir(path.dirname(final), { recursive: true });
    this.fileBase = this.downloadedBytes - partialBytes;
    if (partialBytes < entry.bytes) {
      const url = dictationFileUrl(entry);
      const host = new URL(url).hostname;
      if (!isHuggingFaceDownloadHost(host)) throw failure('download_host_rejected');
      op.phase = 'resolve';
      const resolved = await this._withResponseTimeout(op, (controller) => resolveHuggingFaceAssetUrl(url,
        { fetchImpl: this.fetchImpl, abortController: controller }));
      this._checkCancelled(op);
      if (!resolved.ok) throw failure(resolved.reason);
      op.phase = 'stream';
      await this._stream(resolved.url, partial, partialBytes, entry, op);
    }
    op.phase = 'verify';
    if (this.state !== 'verifying') this._set({ state: 'verifying' });
    if (await this._fileSize(partial) !== entry.bytes) throw failure('size_mismatch');
    const digest = await this._hashFile(partial, op);
    this._checkCancelled(op);
    if (digest !== entry.sha256) {
      await removeFile(partial);
      throw failure('checksum_mismatch');
    }
    await this._renameWithRetry(partial, final);
    this._set({ state: 'downloading' });
  }

  _responseStart(response, partialBytes, entry) {
    const status = response?.status;
    if (partialBytes === 0) {
      if (status !== 200) throw failure('download_failed');
      return 0;
    }
    // A 200 means the server ignored Range and sent the whole file: start over.
    if (status === 200) return 0;
    if (status !== 206) throw failure('download_failed');
    const match = CONTENT_RANGE.exec(String(response.headers?.get?.('content-range') || '').trim());
    if (!match || Number(match[1]) !== partialBytes || Number(match[3]) !== entry.bytes) throw failure('download_failed');
    return partialBytes;
  }

  async _stream(url, partial, partialBytes, entry, op) {
    const controller = op.abortController;
    const headers = partialBytes > 0 ? { Range: `bytes=${partialBytes}-` } : {};
    const response = await this._withResponseTimeout(op, () => this.fetchImpl(url,
      { method: 'GET', redirect: 'error', headers, signal: controller.signal }));
    this._checkCancelled(op);
    let start;
    try {
      start = this._responseStart(response, partialBytes, entry);
      const length = Number(response.headers?.get?.('content-length') || 0);
      if (length > entry.bytes - start) throw failure('byte_overflow');
      if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') throw failure('download_failed');
    } catch (error) {
      try { await response?.body?.cancel?.(); } catch (_error) { /* the reply is discarded */ }
      throw error;
    }
    if (start === 0 && partialBytes > 0) this.downloadedBytes -= partialBytes;
    const handle = await fs.promises.open(partial, start > 0 ? 'a' : 'w');
    let written = start;
    let inactivityTimer = null;
    let inactive = false;
    const resetInactivity = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => { inactive = true; controller.abort(); }, this.inactivityMs);
      inactivityTimer.unref?.();
    };
    try {
      resetInactivity();
      for await (const chunk of response.body) {
        this._checkCancelled(op);
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (written + buffer.length > entry.bytes) { controller.abort(); throw failure('byte_overflow'); }
        resetInactivity();
        for (let offset = 0; offset < buffer.length;) {
          const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
          if (!bytesWritten) throw failure('download_failed');
          offset += bytesWritten;
        }
        written += buffer.length;
        this._progress(this.fileBase + written);
      }
      this._checkCancelled(op);
      if (written !== entry.bytes) throw failure('size_mismatch');
    } catch (error) {
      if (op.cancelled) throw failure('cancelled');
      if (inactive) throw failure('download_inactivity');
      throw error;
    } finally {
      clearTimeout(inactivityTimer);
      await handle.close();
    }
  }

  _progress(done) {
    this.downloadedBytes = done;
    const at = this.now();
    if (at - this.lastProgressEmit >= PROGRESS_INTERVAL_MS) {
      this.lastProgressEmit = at;
      this._emit();
    }
  }

  // install.json goes in last, then the staging directory becomes the final one.
  async _promote(op) {
    const files = this.files.map((entry) => ({ path: entry.relative, bytes: entry.bytes, sha256: entry.sha256 }));
    for (const entry of this.files) {
      if (await this._fileSize(this._stagedPath(entry)) !== entry.bytes) throw failure('size_mismatch');
    }
    this._checkCancelled(op);
    const revisions = {};
    for (const entry of this.files) revisions[entry.subdir] = entry.revision;
    await fs.promises.writeFile(path.join(this.stagingDir, INSTALL_FILE),
      JSON.stringify({ id: this.manifest.id, revisions, files, installedAt: new Date(this.now()).toISOString() }));
    await this._assertPlain([this.finalDir]);
    if (await this._isInstalled()) await removeTree(this.stagingDir);
    else {
      await removeTree(this.finalDir);
      await this._renameWithRetry(this.stagingDir, this.finalDir);
    }
  }

  _stagedPath(entry) { return path.join(this.stagingDir, ...entry.relative.split('/')); }

  // Refuse a symlink or junction at any owned directory before it is written or removed.
  async _assertPlain(dirs) {
    for (const dir of dirs) {
      try {
        const stat = await fs.promises.lstat(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw failure('path_rejected');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  async _fileSize(file) {
    try {
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile()) throw failure('path_rejected');
      return stat.size;
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
  }

  async _freeBytes() {
    let dir = this.root;
    for (;;) {
      try {
        const stats = await this.statfsImpl(dir);
        return Number(stats.bavail) * Number(stats.bsize);
      } catch (error) {
        const parent = path.dirname(dir);
        if (error.code !== 'ENOENT' || parent === dir) throw error;
        dir = parent;
      }
    }
  }

  _withResponseTimeout(op, start) {
    let timer;
    return Promise.race([start(op.abortController), new Promise((_, reject) => {
      timer = setTimeout(() => { op.abortController.abort(); reject(failure('response_timeout')); }, this.responseStartTimeoutMs);
      timer.unref?.();
    })]).finally(() => clearTimeout(timer));
  }

  _checkCancelled(op) { if (op.cancelled) throw failure('cancelled'); }

  async _hashFile(file, op) {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file, { highWaterMark: 1 << 20 }); // 1 MiB reads halve the 652 MB verify
    try {
      for await (const chunk of stream) {
        this._checkCancelled(op);
        hash.update(chunk);
      }
    } finally {
      stream.destroy();
    }
    return hash.digest('hex');
  }

  async _renameWithRetry(from, to) {
    for (let attempt = 1; ; attempt += 1) {
      try { await fs.promises.rename(from, to); return; } catch (error) {
        if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  // Stops the download and keeps the .part files for a later resume. Like the PDF
  // add-on, a user cancel is not a failure: the state returns to not_installed.
  cancel() {
    const op = this.operation;
    // Once every file is verified the install is being promoted: too late to cancel.
    if (op && !op.cancelled && op.phase !== 'promote' && ['downloading', 'verifying'].includes(this.state)) {
      op.cancelled = true;
      op.abortController.abort();
      this._set({ state: 'not_installed', error: null });
    }
    return this.getState();
  }

  async remove() {
    await this.start();
    if (this.operation && !this.operation.cancelled) throw failure('download_in_progress');
    await this.whenIdle();
    await this._assertPlain([this.root]);
    await removeTree(this.finalDir);
    await removeTree(this.stagingDir);
    this._set({ state: 'not_installed', downloadedBytes: 0, error: null });
    return this.getState();
  }

  dispose() {
    this.disposed = true;
    if (this.operation) { this.operation.cancelled = true; this.operation.abortController.abort(); }
    this.removeAllListeners();
  }

  _emit() { if (!this.disposed) this.emit('changed', this.getPublicState()); }

  _log(level, event, fields) {
    try { this.logger?.(level, event, fields); } catch (_error) { /* logging is best effort */ }
  }
}

// Push-to-talk speech model (row 84): builds the service, hangs it on the backend
// service for the IPC registration and bridges its state changes to the renderer.
function wireDictation({ backendService, userDataPath, sendBridgeEvent, log }) {
  const service = new DictationModelService({ userDataPath, logger: log });
  backendService.dictation = service;
  service.on('changed', (state) => sendBridgeEvent('dictation.onChanged', state));
  void service.start();
  return service;
}

module.exports = { DictationModelService, wireDictation };
