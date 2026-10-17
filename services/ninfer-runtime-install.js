'use strict';

// Installs the pinned NInfer runtime (row 54, N2): resolve the release asset's
// single redirect, stream the zip to <install_dirname>.part with the pinned size
// and sha256, extract it into a fresh staging directory, verify every line of
// the zip's own SHA256SUMS and the expected files, then publish the directory
// with one rename. The state file is the installed marker; nothing is executed.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { downloadPinnedFile } = require('./pinned-download');
const { extractWheel } = require('./pdf-addon-wheel');
const { resolveReleaseAssetUrl } = require('./image-engine-service');
const { loadNinferRuntimeManifest, NINFER_RUNTIME_DOWNLOAD_HOSTS } = require('./ninfer-manifests');

const STATE_FILE = 'runtime-state.json';
const STATE_MAX_BYTES = 64 * 1024;
const SUMS_MAX_BYTES = 1024 * 1024;
const SUMS_LINE = /^([0-9a-fA-F]{64}) [ *](.+)$/;
const PATH_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const PROGRESS_INTERVAL_MS = 250;
const REASON = /^[a-z][a-z0-9_]{0,79}$/;
const DOWNLOAD_REASONS = new Set(['response_timeout', 'download_failed', 'byte_overflow', 'cancelled',
  'download_inactivity', 'size_mismatch']);
const PHASE_FAILURE = Object.freeze({ downloading: 'download_failed', verifying: 'sums_mismatch',
  extracting: 'extract_failed', publishing: 'publish_failed' });

function installError(reason) {
  return Object.assign(new Error(reason), { reason });
}

class NinferRuntimeInstallService extends EventEmitter {
  constructor({ userDataPath, runtime = loadNinferRuntimeManifest(), fetchImpl = globalThis.fetch, fsImpl = fs,
    extractImpl = extractWheel, now = Date.now, logger = null, responseStartTimeoutMs = 30_000,
    inactivityMs = 60_000 } = {}) {
    super();
    Object.assign(this, { runtime, fetchImpl, fsImpl, extractImpl, now, logger, responseStartTimeoutMs, inactivityMs });
    this.userDataPath = path.resolve(userDataPath);
    this.root = path.join(this.userDataPath, 'engines', 'ninfer');
    this.target = path.join(this.root, runtime.install_dirname);
    this.partPath = `${this.target}.part`;
    this.stateFile = path.join(this.root, STATE_FILE);
    this.installedDirname = null;
    this.operation = null;
    this.busy = false;
    this.disposed = false;
    this.lastError = null;
    this.progress = null;
    this.lastProgressEmit = -Infinity;
  }

  // Reject junctions along the owned boundary before reads, writes, or recursive removal.
  _assertRoot(create = false) {
    for (const dir of [this.userDataPath, path.dirname(this.root), this.root]) {
      try {
        const stat = this.fsImpl.lstatSync(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw installError('path_rejected');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (create) this.fsImpl.mkdirSync(this.root, { recursive: true });
  }

  _regularFile(file) {
    try { return this.fsImpl.lstatSync(file).isFile(); } catch (_error) { return false; }
  }

  _realDirectory(dir) {
    try {
      const stat = this.fsImpl.lstatSync(dir);
      return stat.isDirectory() && !stat.isSymbolicLink();
    } catch (_error) { return false; }
  }

  _installed() {
    if (this.installedDirname !== this.runtime.install_dirname) return false;
    try { this._assertRoot(); } catch (_error) { return false; }
    return this._realDirectory(this.target) && this._regularFile(path.join(this.target, this.runtime.executable));
  }

  start() {
    if (this.busy || this.disposed) return this.getState();
    this.installedDirname = null;
    try {
      this._assertRoot();
      this._sweep();
      if (this._regularFile(this.stateFile) && this.fsImpl.lstatSync(this.stateFile).size <= STATE_MAX_BYTES) {
        const record = JSON.parse(this.fsImpl.readFileSync(this.stateFile, 'utf8'));
        if (record?.version === 1 && record.installed_dirname === this.runtime.install_dirname) {
          this.installedDirname = record.installed_dirname;
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this._log('WARN', 'start_failed', { reason: this._errorReason(error) || 'state_unreadable' });
    }
    return this.getState();
  }

  getState() {
    return {
      status: this.operation ? 'installing' : this._installed() ? 'installed' : 'not_installed',
      version: this.runtime.version,
      download_size_bytes: this.runtime.size_bytes,
      install: this.progress ? { ...this.progress } : null,
      last_error: this.lastError,
      executable_present: this._regularFile(path.join(this.target, this.runtime.executable)),
    };
  }

  resolveExecutable() {
    if (!this._installed()) return { ok: false, reason: 'not_installed' };
    return { ok: true, path: path.join(this.target, this.runtime.executable), version: this.runtime.version };
  }

  async install(options) {
    if (options?.confirmed !== true) return { ok: false, reason: 'opt_in_required' };
    if (this.busy) return { ok: false, reason: 'busy' };
    if (this.disposed) return { ok: false, reason: 'disposed' };
    if (this._installed()) return { ok: true, already: true };
    const op = { cancelled: false, published: false, abortController: new AbortController(), streams: new Set() };
    const staging = path.join(this.root, `staging-${crypto.randomBytes(8).toString('hex')}`);
    const extract = path.join(staging, 'extract');
    this.operation = op;
    this.busy = true;
    this.lastError = null;
    this.lastProgressEmit = -Infinity;
    this.progress = { phase: 'downloading', done: 0, total: this.runtime.size_bytes };
    let stagingCreated = false;
    let renamed = false;
    let result;
    try {
      this._assertRoot(true);
      this._emit();
      const resolved = await this._resolveUrl(op);
      this._checkCancelled(op);
      if (!resolved.ok) throw installError(resolved.reason);
      await this._rmFile(this.partPath);
      const digest = await downloadPinnedFile({ url: resolved.url, destPath: this.partPath,
        expectedBytes: this.runtime.size_bytes, fetchImpl: this.fetchImpl, fsImpl: this.fsImpl,
        abortController: op.abortController, responseStartTimeoutMs: this.responseStartTimeoutMs,
        inactivityMs: this.inactivityMs, fetchOptions: { redirect: 'error' }, isCancelled: () => op.cancelled,
        onProgress: ({ downloadedBytes }) => this._progress(downloadedBytes) });
      this._checkCancelled(op);
      this._phase('verifying');
      if (digest.toLowerCase() !== this.runtime.sha256.toLowerCase()) throw installError('digest_mismatch');
      this._phase('extracting');
      await this.fsImpl.promises.mkdir(staging);
      stagingCreated = true;
      await this.fsImpl.promises.mkdir(extract);
      const limits = this.runtime.extract_limits;
      await this.extractImpl({ wheelPath: this.partPath, destDir: extract, fsImpl: this._extractionFs(op),
        limits: { maxEntries: limits.max_entries, maxEntryUncompressedBytes: limits.max_entry_uncompressed_bytes,
          maxTotalUncompressedBytes: limits.max_total_uncompressed_bytes } });
      this._checkCancelled(op);
      this._phase('verifying');
      const content = this._contentDir(extract);
      await this._verifySums(content, op);
      if (!this.runtime.expected_files.every((name) => this._regularFile(path.join(content, name)))) {
        throw installError('expected_file_missing');
      }
      this._checkCancelled(op);
      // No await between the cancellation check and the publication boundary.
      op.published = true;
      this._phase('publishing');
      this._assertRoot();
      await this.fsImpl.promises.rm(this.target, { recursive: true, force: true });
      await this._renameWithRetry(content, this.target);
      renamed = true;
      this.installedDirname = this.runtime.install_dirname;
      await this._writeState();
      this._log('INFO', 'installed', { phase: 'publishing' });
      result = { ok: true };
    } catch (error) {
      const reason = this._failureReason(error, op);
      if (renamed) {
        // The state file is the installed marker: without it the published directory must not survive.
        this.installedDirname = null;
        try { await this.fsImpl.promises.rm(this.target, { recursive: true, force: true }); }
        catch (_error) { this._log('WARN', 'cleanup_failed', { reason: 'publish_failed' }); }
      }
      this.lastError = reason;
      // A cancel is the user's choice, not a failure for Diagnostics to flag.
      if (reason === 'cancelled') this._log('INFO', 'install_cancelled', { phase: this.progress.phase });
      else this._log('WARN', 'install_failed', { phase: this.progress.phase, reason });
      result = { ok: false, reason };
    } finally {
      try {
        this._assertRoot();
        if (stagingCreated) await this.fsImpl.promises.rm(staging, { recursive: true, force: true, maxRetries: 3 });
        await this._rmFile(this.partPath);
      } catch (_error) { this._log('WARN', 'cleanup_failed', { reason: 'cleanup_failed' }); }
      this.operation = null;
      this.busy = false;
      this.progress = null;
      this._emit();
    }
    return result;
  }

  _failureReason(error, op) {
    if (op.cancelled && !op.published) return 'cancelled';
    const reason = this._errorReason(error);
    if (reason) return reason;
    if (DOWNLOAD_REASONS.has(error?.code)) return error.code;
    return PHASE_FAILURE[this.progress.phase] || 'download_failed';
  }

  _errorReason(error) {
    return typeof error?.reason === 'string' && REASON.test(error.reason) ? error.reason : null;
  }

  async _resolveUrl(op) {
    let timer;
    try {
      return await Promise.race([resolveReleaseAssetUrl(this.runtime.url, { fetchImpl: this.fetchImpl,
        allowedHosts: NINFER_RUNTIME_DOWNLOAD_HOSTS, abortController: op.abortController }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(installError('response_timeout'));
          op.abortController.abort();
        }, this.responseStartTimeoutMs);
        timer.unref?.();
      })]);
    } finally { clearTimeout(timer); }
  }

  _progress(done) {
    if (!this.progress || done < this.progress.done) return;
    this.progress.done = done;
    const now = this.now();
    if (now - this.lastProgressEmit >= PROGRESS_INTERVAL_MS) {
      this.lastProgressEmit = now;
      this._emit();
    }
  }

  _checkCancelled(op) {
    if (op.cancelled) throw installError('cancelled');
  }

  _extractionFs(op) {
    return { ...this.fsImpl, promises: { ...this.fsImpl.promises,
      mkdir: async (...args) => { this._checkCancelled(op); return this.fsImpl.promises.mkdir(...args); } },
    createWriteStream: (...args) => {
      this._checkCancelled(op);
      const stream = this.fsImpl.createWriteStream(...args);
      op.streams.add(stream);
      stream.once('close', () => op.streams.delete(stream));
      return stream;
    } };
  }

  // The release zip wraps everything in one top-level folder; a flat zip is used as is.
  _contentDir(extract) {
    const names = this.fsImpl.readdirSync(extract);
    if (names.length === 1 && this._realDirectory(path.join(extract, names[0]))) return path.join(extract, names[0]);
    return extract;
  }

  _containedPath(content, relative) {
    const segments = relative.split('/');
    if (!segments.every((segment) => PATH_SEGMENT.test(segment) && !/[. ]$/.test(segment))) return null;
    const file = path.join(content, ...segments);
    const rel = path.relative(content, file);
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? file : null;
  }

  async _verifySums(content, op) {
    const sumsPath = path.join(content, this.runtime.sums_file);
    if (!this._regularFile(sumsPath)) throw installError('sums_missing');
    if (this.fsImpl.lstatSync(sumsPath).size > SUMS_MAX_BYTES) throw installError('sums_mismatch');
    const text = (await this.fsImpl.promises.readFile(sumsPath, 'utf8')).replace(/^\uFEFF/, '');
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    if (!lines.length) throw installError('sums_mismatch');
    for (const line of lines) {
      const match = SUMS_LINE.exec(line);
      const file = match && this._containedPath(content, match[2]);
      if (!file || !this._regularFile(file)) throw installError('sums_mismatch');
      if (await this._hashFile(file, op) !== match[1].toLowerCase()) throw installError('sums_mismatch');
    }
  }

  async _hashFile(file, op) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of this.fsImpl.createReadStream(file)) {
      this._checkCancelled(op);
      hash.update(chunk);
    }
    return hash.digest('hex');
  }

  cancel() {
    const op = this.operation;
    if (!op) return { ok: false, reason: 'idle' };
    if (op.published) return { ok: false, reason: 'publishing' };
    op.cancelled = true;
    op.abortController.abort();
    for (const stream of op.streams) stream.destroy(installError('cancelled'));
    return { ok: true };
  }

  async remove(options) {
    if (options?.confirmed !== true) return { ok: false, reason: 'opt_in_required' };
    if (this.busy) return { ok: false, reason: 'busy' };
    if (this.disposed) return { ok: false, reason: 'disposed' };
    this.busy = true;
    try {
      this._assertRoot();
      // Only this module's directory, staging and partials: siblings such as models/ belong elsewhere.
      await this.fsImpl.promises.rm(this.target, { recursive: true, force: true, maxRetries: 3 });
      this._sweep();
      await this._rmFile(this.stateFile);
      this.installedDirname = null;
      this.lastError = null;
      this._log('INFO', 'removed', {});
      return { ok: true };
    } catch (error) {
      const reason = this._errorReason(error) || 'remove_failed';
      this._log('WARN', 'remove_failed', { reason });
      return { ok: false, reason };
    } finally {
      this.busy = false;
      this._emit();
    }
  }

  // Runtime partials restart from zero, so every root-level *.part and staging-* is discarded.
  _sweep() {
    let names;
    try { names = this.fsImpl.readdirSync(this.root); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const name of names) {
      const entry = path.join(this.root, name);
      const stat = this.fsImpl.lstatSync(entry);
      if (name.startsWith('staging-') && (stat.isDirectory() || stat.isSymbolicLink())) {
        this.fsImpl.rmSync(entry, { recursive: true, force: true });
      } else if (name.endsWith('.part') && (stat.isFile() || stat.isSymbolicLink())) {
        this.fsImpl.rmSync(entry, { force: true });
      }
    }
  }

  async _rmFile(file) {
    await this.fsImpl.promises.rm(file, { force: true, maxRetries: 3 });
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

  async _writeState() {
    this._assertRoot(true);
    const temp = `${this.stateFile}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
      await this.fsImpl.promises.writeFile(temp, `${JSON.stringify({ version: 1,
        installed_dirname: this.installedDirname, updated_at: this.now() }, null, 2)}\n`, { flag: 'wx' });
      await this._renameWithRetry(temp, this.stateFile);
    } finally { await this._rmFile(temp); }
  }

  _phase(phase) {
    this.progress.phase = phase;
    this._emit();
  }

  _emit() {
    if (!this.disposed) this.emit('changed', this.getState());
  }

  _log(level, event, fields) {
    try { this.logger?.(level, `ninfer_runtime.${event}`, fields); } catch (_error) { /* logging is best effort */ }
  }

  dispose() {
    if (this.operation && !this.operation.published) this.cancel();
    this.disposed = true;
    this.removeAllListeners();
  }
}

module.exports = { NinferRuntimeInstallService, NINFER_RUNTIME_STATE_FILE: STATE_FILE };
