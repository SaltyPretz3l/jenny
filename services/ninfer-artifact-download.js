'use strict';

// Opt-in, resumable download of a pinned NInfer `.ninfer` model artifact from
// Hugging Face, plus discovery of `.ninfer` files on disk. The partial file is
// kept on cancel and on network failure so the next download resumes with an
// HTTP Range request; the sha256 is computed over the whole finished file.
// Logs carry phase names and reason codes only, never URLs or paths.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { pinnedDownloadError } = require('./pinned-download');
const { loadNinferArtifactManifest, isHuggingFaceDownloadHost } = require('./ninfer-manifests');
const { isLocalAbsolutePath } = require('./shell-config-engines');

const DISK_HEADROOM_BYTES = 64 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 250;
const MAX_DISCOVERED = 64;
const PARTIAL_SUFFIX = '.part';
const NINFER_FILE = /\.ninfer$/i;
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/;
const REASON = /^[a-z][a-z0-9_]{0,79}$/;

function downloadError(reason) {
  return Object.assign(new Error(reason), { reason });
}

async function resolveHuggingFaceAssetUrl(url, { fetchImpl, abortController } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      ...(abortController ? { signal: abortController.signal } : {}) });
    if (response?.status === 200) return { ok: true, url };
    if (![301, 302, 307, 308].includes(response?.status)) return { ok: false, reason: 'download_failed' };
    const location = new URL(response.headers?.get?.('location'));
    if (location.protocol !== 'https:') return { ok: false, reason: 'redirect_scheme_rejected' };
    if (!isHuggingFaceDownloadHost(location.hostname) || location.username || location.password) {
      return { ok: false, reason: 'redirect_host_rejected' };
    }
    return { ok: true, url: location.href };
  } catch (_error) {
    return { ok: false, reason: abortController?.signal.aborted ? 'cancelled' : 'download_failed' };
  } finally {
    try { await response?.body?.cancel?.(); } catch (_error) { /* discard the unused first-hop body */ }
  }
}

class NinferArtifactDownloadService extends EventEmitter {
  constructor({ userDataPath, artifacts = loadNinferArtifactManifest().artifacts, fetchImpl = globalThis.fetch,
    fsImpl = fs, statfsImpl = fs.promises.statfs, now = Date.now, logger = null,
    responseStartTimeoutMs = 30_000, inactivityMs = 60_000, platform = process.platform }) {
    super();
    Object.assign(this, { artifacts, fetchImpl, fsImpl, statfsImpl, now, logger, responseStartTimeoutMs,
      inactivityMs, platform });
    this.userDataPath = path.resolve(userDataPath);
    this.modelsDir = path.join(this.userDataPath, 'engines', 'ninfer', 'models');
    this.operation = null;
    this.artifactId = null;
    this.progress = null;
    this.lastError = null;
    this.lastProgressEmit = -Infinity;
    this.removing = false;
    this.disposed = false;
  }

  getState() {
    return {
      status: this.operation ? 'downloading' : 'idle',
      phase: this.operation ? String(this.operation.phase || '') : '',
      artifact_id: this.artifactId,
      download: this.progress ? { ...this.progress } : null,
      last_error: this.lastError,
    };
  }

  _artifact(id) { return this.artifacts.find((artifact) => artifact.id === id) || null; }

  // The published file for a pinned id: ok only for a regular file of the
  // pinned size inside the owned models directory (junctions refused).
  async resolveArtifactPath(id) {
    const artifact = this._artifact(id);
    if (!artifact) return { ok: false, reason: 'unknown_artifact' };
    try {
      await this._assertRoot();
      const { final } = this._paths(artifact);
      const size = await this._fileSize(final);
      if (size !== artifact.size_bytes) return { ok: false, reason: size === 0 ? 'not_downloaded' : 'size_mismatch' };
      return { ok: true, path: final, artifact };
    } catch (error) {
      return { ok: false, reason: typeof error?.reason === 'string' ? error.reason : 'ninfer_path_rejected' };
    }
  }

  _paths(artifact) {
    const final = path.join(this.modelsDir, artifact.file);
    return { final, partial: `${final}${PARTIAL_SUFFIX}` };
  }

  // Reject junctions along the owned boundary before reads, writes or removal.
  async _assertRoot() {
    const engines = path.join(this.userDataPath, 'engines');
    for (const dir of [this.userDataPath, engines, path.dirname(this.modelsDir), this.modelsDir]) {
      try {
        const stat = await this.fsImpl.promises.lstat(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw downloadError('ninfer_path_rejected');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }

  // Size of a regular file, 0 when absent; anything else at the path is refused.
  async _fileSize(file) {
    try {
      const stat = await this.fsImpl.promises.lstat(file);
      if (!stat.isFile()) throw downloadError('ninfer_path_rejected');
      return stat.size;
    } catch (error) {
      if (error.code === 'ENOENT') return 0;
      throw error;
    }
  }

  // statfs the models directory, or its nearest existing ancestor before the first download.
  async _freeBytes() {
    let dir = this.modelsDir;
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

  async download(options) {
    if (options?.confirmed !== true) return { ok: false, reason: 'opt_in_required' };
    if (this.disposed) return { ok: false, reason: 'disposed' };
    if (this.operation || this.removing) return { ok: false, reason: 'busy' };
    const artifact = this._artifact(options.id);
    if (!artifact) return { ok: false, reason: 'unknown_artifact' };
    const op = { id: artifact.id, cancelled: false, abortController: new AbortController() };
    this.operation = op;
    try {
      const result = await this._download(artifact, op);
      if (result.ok) { this.lastError = null; if (!result.already) this.progress = null; }
      else this.lastError = result.reason;
      return result;
    } catch (error) {
      const reason = op.cancelled ? 'cancelled'
        : typeof error?.reason === 'string' && REASON.test(error.reason) ? error.reason
          : typeof error?.code === 'string' && REASON.test(error.code) ? error.code : 'download_failed';
      this.lastError = reason;
      // A cancel is the user's choice, not a failure for Diagnostics to flag.
      if (reason === 'cancelled') this._log('info', 'download_cancelled', { phase: op.phase || 'download' });
      else this._log('warn', 'download_failed', { phase: op.phase || 'download', reason });
      return { ok: false, reason };
    } finally {
      this.operation = null;
      this._emit();
    }
  }

  async _download(artifact, op) {
    const { final, partial } = this._paths(artifact);
    await this._assertRoot();
    if (await this._fileSize(final) === artifact.size_bytes) return { ok: true, already: true };
    let partialBytes = await this._fileSize(partial);
    if (partialBytes > artifact.size_bytes) {
      await this.fsImpl.promises.truncate(partial, 0);
      partialBytes = 0;
    }
    op.phase = 'disk_check';
    const needed = artifact.size_bytes - partialBytes + DISK_HEADROOM_BYTES;
    let free = null;
    try { free = await this._freeBytes(); } catch (_error) { this._log('warn', 'disk_check_skipped', { phase: op.phase }); }
    if (free !== null && Number.isFinite(free) && free < needed) {
      return { ok: false, reason: 'ninfer_disk_space', needed_bytes: needed, free_bytes: free };
    }
    this.artifactId = artifact.id;
    this.progress = { done: partialBytes, total: artifact.size_bytes, resumed_from: partialBytes };
    this.lastError = null;
    this.lastProgressEmit = -Infinity;
    this._emit();
    await this.fsImpl.promises.mkdir(this.modelsDir, { recursive: true });
    if (partialBytes < artifact.size_bytes) {
      op.phase = 'resolve';
      const resolved = await this._withResponseTimeout(op, (controller) => resolveHuggingFaceAssetUrl(artifact.url,
        { fetchImpl: this.fetchImpl, abortController: controller }));
      this._checkCancelled(op);
      if (!resolved.ok) throw downloadError(resolved.reason);
      op.phase = 'stream';
      this._log('info', 'download_started', { phase: op.phase, resumed: partialBytes > 0 });
      await this._stream(resolved.url, partial, partialBytes, artifact, op);
    }
    op.phase = 'verify';
    if (await this._fileSize(partial) !== artifact.size_bytes) throw pinnedDownloadError('size_mismatch');
    const digest = await this._hashFile(partial, op);
    // A cancel that landed after the last hashed chunk must not publish.
    this._checkCancelled(op);
    if (digest !== artifact.sha256.toLowerCase()) {
      await this.fsImpl.promises.rm(partial, { force: true });
      this.progress = null;
      this._log('warn', 'download_failed', { phase: op.phase, reason: 'digest_mismatch' });
      return { ok: false, reason: 'digest_mismatch' };
    }
    op.phase = 'publish';
    await this._renameWithRetry(partial, final);
    this._log('info', 'download_finished', { phase: op.phase });
    return { ok: true };
  }

  _withResponseTimeout(op, start) {
    let timer;
    return Promise.race([start(op.abortController), new Promise((_, reject) => {
      timer = setTimeout(() => {
        op.abortController.abort();
        reject(pinnedDownloadError('response_timeout'));
      }, this.responseStartTimeoutMs);
      timer.unref?.();
    })]).finally(() => clearTimeout(timer));
  }

  _checkCancelled(op) { if (op.cancelled) throw downloadError('cancelled'); }

  // Validates the reply and returns the offset its body starts at.
  _responseStart(response, partialBytes, artifact) {
    const status = response?.status;
    if (partialBytes === 0) {
      if (status !== 200) throw pinnedDownloadError('download_failed');
      return 0;
    }
    if (status === 200) {
      // The server ignored the Range header and sent the whole file: start over.
      this._log('info', 'range_ignored', { phase: 'stream' });
      return 0;
    }
    if (status !== 206) throw pinnedDownloadError('download_failed');
    const match = CONTENT_RANGE.exec(String(response.headers?.get?.('content-range') || '').trim());
    if (!match || Number(match[1]) !== partialBytes || Number(match[3]) !== artifact.size_bytes) {
      throw pinnedDownloadError('download_failed');
    }
    return partialBytes;
  }

  async _stream(url, partial, partialBytes, artifact, op) {
    const controller = op.abortController;
    const headers = partialBytes > 0 ? { Range: `bytes=${partialBytes}-` } : {};
    const response = await this._withResponseTimeout(op, () => this.fetchImpl(url,
      { method: 'GET', redirect: 'error', headers, signal: controller.signal }));
    this._checkCancelled(op);
    let start;
    try {
      start = this._responseStart(response, partialBytes, artifact);
      const length = Number(response.headers?.get?.('content-length') || 0);
      if (length > artifact.size_bytes - start) throw pinnedDownloadError('byte_overflow');
      if (!response.body || typeof response.body[Symbol.asyncIterator] !== 'function') {
        throw pinnedDownloadError('download_failed');
      }
    } catch (error) {
      try { await response?.body?.cancel?.(); } catch (_error) { /* the reply is discarded */ }
      throw error;
    }
    if (start === 0 && partialBytes > 0) this.progress = { ...this.progress, done: 0, resumed_from: 0 };
    const handle = await this.fsImpl.promises.open(partial, start > 0 ? 'a' : 'w');
    let written = start;
    let inactivityTimer = null;
    let inactivityTriggered = false;
    const resetInactivity = () => {
      clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => { inactivityTriggered = true; controller.abort(); }, this.inactivityMs);
      inactivityTimer.unref?.();
    };
    try {
      resetInactivity();
      for await (const chunk of response.body) {
        this._checkCancelled(op);
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        if (written + buffer.length > artifact.size_bytes) {
          controller.abort();
          throw pinnedDownloadError('byte_overflow');
        }
        resetInactivity();
        for (let offset = 0; offset < buffer.length;) {
          const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
          if (!bytesWritten) throw pinnedDownloadError('download_failed');
          offset += bytesWritten;
        }
        written += buffer.length;
        this._progress(written);
      }
      this._checkCancelled(op);
      if (written !== artifact.size_bytes) throw pinnedDownloadError('size_mismatch');
    } catch (error) {
      if (op.cancelled) throw downloadError('cancelled');
      if (inactivityTriggered) throw pinnedDownloadError('download_inactivity');
      throw error;
    } finally {
      clearTimeout(inactivityTimer);
      await handle.close();
    }
  }

  _progress(done) {
    if (!this.progress || done <= this.progress.done) return;
    this.progress.done = done;
    const now = this.now();
    if (now - this.lastProgressEmit >= PROGRESS_INTERVAL_MS) {
      this.lastProgressEmit = now;
      this._emit();
    }
  }

  async _hashFile(file, op) {
    const hash = crypto.createHash('sha256');
    const stream = this.fsImpl.createReadStream(file);
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
      try { await this.fsImpl.promises.rename(from, to); return; }
      catch (error) {
        if (attempt >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  async cancel() {
    const op = this.operation;
    if (!op) return { ok: false, reason: 'idle' };
    op.cancelled = true;
    op.abortController.abort();
    return { ok: true };
  }

  async remove(options) {
    if (options?.confirmed !== true) return { ok: false, reason: 'opt_in_required' };
    const artifact = this._artifact(options.id);
    if (!artifact) return { ok: false, reason: 'unknown_artifact' };
    if (this.operation || this.removing) return { ok: false, reason: 'busy' };
    // Held across the awaits below so a download cannot start beside a removal.
    this.removing = true;
    try {
      await this._assertRoot();
      const { final, partial } = this._paths(artifact);
      for (const file of [final, partial]) {
        await this._fileSize(file);
        await this.fsImpl.promises.rm(file, { force: true });
      }
    } catch (error) {
      const reason = typeof error?.reason === 'string' ? error.reason : 'ninfer_remove_failed';
      this._log('warn', 'remove_failed', { phase: 'remove', reason });
      return { ok: false, reason };
    } finally {
      this.removing = false;
    }
    if (this.artifactId === artifact.id) { this.progress = null; this.lastError = null; }
    this._emit();
    return { ok: true };
  }

  _match(name, size) {
    const key = this.platform === 'win32' ? name.toLowerCase() : name;
    return this.artifacts.find((artifact) => (this.platform === 'win32' ? artifact.file.toLowerCase()
      : artifact.file) === key && artifact.size_bytes === size) || null;
  }

  // True for a directory that is not itself a link or junction (lstat sees a
  // junction as a symbolic link); the root's ancestors are the user's choice.
  async _isPlainDirectory(dir) {
    try {
      const stat = await this.fsImpl.promises.lstat(dir);
      return stat.isDirectory() && !stat.isSymbolicLink();
    } catch (_error) { return false; }
  }

  async _readDir(dir) {
    try { return await this.fsImpl.promises.readdir(dir, { withFileTypes: true }); }
    catch (_error) { return []; }
  }

  // Lists `*.ninfer` regular files directly inside dir; never follows links.
  async _scanFiles(dir, dirents, source, entries, seen) {
    for (const dirent of dirents) {
      if (entries.length >= MAX_DISCOVERED) return;
      if (dirent.isSymbolicLink() || !dirent.isFile() || !NINFER_FILE.test(dirent.name)) continue;
      const file = path.join(dir, dirent.name);
      const key = path.resolve(file).toLowerCase();
      if (seen.has(key)) continue;
      let stat;
      try { stat = await this.fsImpl.promises.lstat(file); } catch (_error) { continue; }
      if (!stat.isFile()) continue;
      seen.add(key);
      // `complete` means name and size match a pinned artifact; the hash is
      // checked only by download(), so a library file is trusted no further
      // than any other user-chosen model path.
      const artifact = this._match(dirent.name, stat.size);
      entries.push({ id: artifact ? artifact.id : null, file: dirent.name, size_bytes: stat.size, path: file,
        source, recognised: Boolean(artifact), complete: Boolean(artifact) });
    }
  }

  async discover({ libraryRoots = [] } = {}) {
    const entries = [];
    const seen = new Set();
    try {
      await this._assertRoot();
      await this._scanFiles(this.modelsDir, await this._readDir(this.modelsDir), 'managed', entries, seen);
    } catch (_error) { this._log('warn', 'discover_managed_skipped', { phase: 'discover' }); }
    for (const root of Array.isArray(libraryRoots) ? libraryRoots : []) {
      if (entries.length >= MAX_DISCOVERED) break;
      if (!isLocalAbsolutePath(root, { platform: this.platform })) {
        this._log('info', 'discover_root_skipped', { phase: 'discover', reason: 'root_not_local' });
        continue;
      }
      const dir = path.resolve(root);
      if (!(await this._isPlainDirectory(dir))) {
        this._log('info', 'discover_root_skipped', { phase: 'discover', reason: 'root_not_plain_directory' });
        continue;
      }
      const dirents = await this._readDir(dir);
      await this._scanFiles(dir, dirents, 'library', entries, seen);
      for (const dirent of dirents) {
        if (entries.length >= MAX_DISCOVERED) break;
        if (dirent.isSymbolicLink() || !dirent.isDirectory()) continue;
        const sub = path.join(dir, dirent.name);
        await this._scanFiles(sub, await this._readDir(sub), 'library', entries, seen);
      }
    }
    return { entries };
  }

  dispose() {
    this.disposed = true;
    if (this.operation) { this.operation.cancelled = true; this.operation.abortController.abort(); }
    this.removeAllListeners();
  }

  _emit() { if (!this.disposed) this.emit('changed', this.getState()); }

  _log(level, event, fields) {
    try { this.logger?.(level, `ninfer_artifact.${event}`, fields); } catch (_error) { /* logging is best effort */ }
  }
}

module.exports = { NinferArtifactDownloadService, resolveHuggingFaceAssetUrl };
