'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { downloadPinnedFile } = require('./pinned-download');
const { extractWheel } = require('./pdf-addon-wheel');
const { GITHUB_UPDATE_HOSTS } = require('./github-release-client');
const { sanitizeSpawnEnv } = require('./backend/sanitize-spawn-env');

const ENGINE_DIRECTORY = 'engines';
const INSTALL_RECORD = '.jenny-engine-install.json';
const INSTALL_RECORD_MAX_BYTES = 64 * 1024;
const DIRECTORY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const FILE_NAME = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const DOWNLOAD_REASONS = new Set(['response_timeout', 'download_failed', 'byte_overflow', 'cancelled',
  'download_inactivity', 'size_mismatch']);

function engineError(reason) {
  return Object.assign(new Error(reason), { reason });
}

function validPin(pin) {
  try {
    const url = new URL(pin?.url);
    return url.protocol === 'https:' && GITHUB_UPDATE_HOSTS.includes(url.hostname)
      && !url.username && !url.password
      && Number.isSafeInteger(pin.sizeBytes) && pin.sizeBytes > 0
      && /^[0-9a-f]{64}$/i.test(pin.sha256)
      && /^[A-Za-z0-9._-]+\.zip$/.test(pin.filename)
      && url.pathname.endsWith(`/${pin.filename}`);
  } catch (_error) {
    return false;
  }
}

function isSdCliRuntimePath(value, { platform = process.platform } = {}) {
  if (typeof value !== 'string' || !value || value.length > 1024) return false;
  // eslint-disable-next-line no-control-regex -- reject executable paths containing C0 controls or DEL.
  if (/[\u0000-\u001f\u007f]/.test(value) || /[\\/]$/.test(value)) return false;
  if (platform === 'win32') {
    return /^[A-Za-z]:\\/.test(value) && value.indexOf(':', 2) === -1
      && path.win32.normalize(value) === value
      && path.win32.basename(value).toLowerCase() === 'sd-cli.exe';
  }
  return value.startsWith('/') && path.posix.normalize(value) === value
    && path.posix.basename(value) === 'sd-cli';
}

function parseSdCliBanner(text) {
  if (typeof text !== 'string') return null;
  const match = text.match(/^[ \t]*stable-diffusion\.cpp version [^\r\n,]+, commit ([0-9a-f]{7,40})[ \t]*\r?$/mi);
  return match ? { commit: match[1].toLowerCase() } : null;
}

async function resolveReleaseAssetUrl(url, { fetchImpl, allowedHosts = GITHUB_UPDATE_HOSTS, abortController } = {}) {
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'manual',
      ...(abortController ? { signal: abortController.signal } : {}) });
    if (response?.status === 200) return { ok: true, url };
    if (![301, 302, 307, 308].includes(response?.status)) return { ok: false, reason: 'download_failed' };
    const location = new URL(response.headers?.get?.('location'));
    if (location.protocol !== 'https:') return { ok: false, reason: 'redirect_scheme_rejected' };
    if (!allowedHosts.includes(location.hostname) || location.username || location.password) {
      return { ok: false, reason: 'redirect_host_rejected' };
    }
    return { ok: true, url: location.href };
  } catch (_error) {
    return { ok: false, reason: abortController?.signal.aborted ? 'cancelled' : 'download_failed' };
  } finally {
    try { await response?.body?.cancel?.(); } catch (_error) { /* discard the unused first-hop body */ }
  }
}

class ImageEngineService extends EventEmitter {
  constructor({ userDataPath,
    manifestPath = path.join(__dirname, '..', 'config', 'sdcpp-engine-manifest.json'),
    platform = process.platform, arch = process.arch, fetchImpl = globalThis.fetch, fsImpl = fs,
    execFileImpl = execFile, extractImpl = extractWheel, now = Date.now, logger = null,
    responseStartTimeoutMs = 30_000, inactivityMs = 60_000 }) {
    super();
    Object.assign(this, { platform, fetchImpl, fsImpl, execFileImpl, extractImpl, now, logger,
      responseStartTimeoutMs, inactivityMs });
    this.userDataPath = path.resolve(userDataPath);
    this.root = path.join(this.userDataPath, ENGINE_DIRECTORY, 'sdcpp');
    this.stateFile = path.join(this.root, 'state.json');
    this.installedTag = null;
    this.stateTag = null;
    this.customExecutable = null;
    this.operation = null;
    this.busy = false;
    this.disposed = false;
    this.lastError = null;
    this.configError = null;
    this.progress = null;
    this.lastProgressEmit = -Infinity;
    try {
      this.manifest = JSON.parse(fsImpl.readFileSync(manifestPath, 'utf8'));
      this.pin = this.manifest?.platforms?.[`${platform}-${arch}`];
      if (!this.pin) this.configError = 'platform_unsupported';
      else if (!this._validManifest()) this.configError = 'image_engine_manifest_invalid';
    } catch (_error) {
      this.configError = 'image_engine_manifest_invalid';
    }
    this.lastError = this.configError;
  }

  _validManifest() {
    const pin = this.pin;
    return DIRECTORY_NAME.test(this.manifest.tag) && !this.manifest.tag.startsWith('staging-')
      && this.manifest.tag !== 'state.json' && /^[0-9a-f]{7,40}$/i.test(this.manifest.commit)
      && Array.isArray(pin.assets) && pin.assets.length === 2 && pin.assets.every(validPin)
      && new Set(pin.assets.map((asset) => asset.filename.toLowerCase())).size === pin.assets.length
      && Number.isSafeInteger(pin.assets.reduce((sum, asset) => sum + asset.sizeBytes, 0))
      && Array.isArray(pin.expectedFiles) && pin.expectedFiles.length > 0
      && pin.expectedFiles.every((name) => typeof name === 'string' && FILE_NAME.test(name) && !/[. ]$/.test(name))
      && pin.expectedFiles.includes(pin.executable)
      && isSdCliRuntimePath(this.platform === 'win32' ? `C:\\engine\\${pin.executable}` : `/engine/${pin.executable}`,
        { platform: this.platform })
      && ['maxEntries', 'maxEntryUncompressedBytes', 'maxTotalUncompressedBytes']
        .every((key) => Number.isSafeInteger(pin.extractLimits?.[key]) && pin.extractLimits[key] > 0);
  }

  // Reject junctions along the owned boundary before reads, writes, or recursive removal.
  _assertRoot(create = false) {
    for (const dir of [this.userDataPath, path.dirname(this.root), this.root]) {
      try {
        const stat = this.fsImpl.lstatSync(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw engineError('image_engine_path_rejected');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (create) this.fsImpl.mkdirSync(this.root, { recursive: true });
  }

  _regularFile(file) {
    try { return this.fsImpl.lstatSync(file).isFile(); } catch (_error) { return false; }
  }

  // Expected size when the install record knows it; otherwise any non-empty regular file.
  _fileSizeMatches(file, expected) {
    try {
      const stat = this.fsImpl.lstatSync(file);
      if (!stat.isFile() || stat.size <= 0) return false;
      return expected === undefined || (Number.isSafeInteger(expected) && stat.size === expected);
    } catch (_error) { return false; }
  }

  // Bounded read of the record the install publishes with the files; any failure means "no record".
  _readInstallRecord(dir) {
    let fd = null;
    try {
      const file = path.join(dir, INSTALL_RECORD);
      if (!this._regularFile(file)) return null;
      fd = this.fsImpl.openSync(file, 'r');
      const buffer = Buffer.alloc(INSTALL_RECORD_MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const read = this.fsImpl.readSync(fd, buffer, length, buffer.length - length, length);
        if (!read) break;
        length += read;
      }
      if (length > INSTALL_RECORD_MAX_BYTES) return null;
      const record = JSON.parse(buffer.toString('utf8', 0, length));
      return record?.version === 1 && typeof record.tag === 'string' && typeof record.commit === 'string'
        && record.files && typeof record.files === 'object' ? record : null;
    } catch (_error) { return null; }
    finally {
      if (fd !== null) { try { this.fsImpl.closeSync(fd); } catch (_error) { /* read-only handle */ } }
    }
  }

  // Cheap enough for every getState(): one small read plus stat calls, no hashing or process spawn.
  _managedPresent() {
    if (this.configError) return false;
    try {
      this._assertRoot();
      const dir = path.join(this.root, this.manifest.tag);
      const stat = this.fsImpl.lstatSync(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      const record = this._readInstallRecord(dir);
      if (record) {
        if (record.tag !== this.manifest.tag || record.commit.toLowerCase() !== this.manifest.commit.toLowerCase()) return false;
        return this.pin.expectedFiles.every((name) => this._fileSizeMatches(path.join(dir, name), record.files[name] ?? null));
      }
      // An install from before the record: the state record names the tag.
      return this.installedTag === this.manifest.tag
        && this.pin.expectedFiles.every((name) => this._fileSizeMatches(path.join(dir, name)));
    } catch (_error) { return false; }
  }

  _customPresent() {
    if (!this.customExecutable) return false;
    try { return this.fsImpl.statSync(this.customExecutable).isFile(); } catch (_error) { return false; }
  }

  start() {
    if (this.busy || this.disposed) return this.getState();
    try {
      this._assertRoot();
      this._sweepStaging();
      if (this._regularFile(this.stateFile)) {
        const record = JSON.parse(this.fsImpl.readFileSync(this.stateFile, 'utf8'));
        if (record.version === 1) {
          this.stateTag = typeof record.installed_tag === 'string' ? record.installed_tag : null;
          this.installedTag = !this.configError && record.installed_tag === this.manifest.tag ? record.installed_tag : null;
          this.customExecutable = isSdCliRuntimePath(record.custom_executable, { platform: this.platform })
            ? record.custom_executable : null;
        }
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.lastError = this.configError || 'image_engine_state_failed';
    }
    // A published directory is adopted by its own install record, whatever state.json says.
    this.installedTag = this._managedPresent() ? this.manifest.tag : null;
    return this.getState();
  }

  getState() {
    const custom = this._customPresent();
    const managed = this._managedPresent();
    return {
      engine_tag: this.manifest?.tag || null,
      status: this.configError ? 'error' : this.operation ? 'installing' : this.lastError ? 'error'
        : custom ? 'custom' : managed ? 'installed' : 'not_installed',
      source: custom ? 'custom' : managed ? 'managed' : null,
      executable_path_present: custom || managed,
      install: this.progress ? { ...this.progress } : null,
      last_error: this.lastError,
      custom_executable: this.customExecutable,
      download_size_bytes: this.configError ? 0 : this.pin.assets.reduce((sum, asset) => sum + asset.sizeBytes, 0),
      extracted_size_bytes: this.pin?.extractedSizeBytes || 0,
      license: { name: this.manifest?.license || '', url: this.manifest?.licenseUrl || '' },
    };
  }

  resolveExecutable() {
    if (this._customPresent()) return { ok: true, path: this.customExecutable, source: 'custom', tag: this.manifest?.tag || null };
    if (this._managedPresent()) return { ok: true, path: path.join(this.root, this.manifest.tag, this.pin.executable),
      source: 'managed', tag: this.manifest.tag };
    return { ok: false, reason: 'image_engine_missing' };
  }

  async reconcileState() {
    if (this.busy || this.disposed) return this.getState();
    if (this.installedTag && !this._managedPresent()) {
      this.busy = true;
      this.installedTag = null;
      try { await this._persist(); } catch (_error) { this.lastError = 'image_engine_state_failed'; }
      finally { this.busy = false; }
      this._emit();
    }
    return this.getState();
  }

  async install(options) {
    if (options?.confirmed !== true) return { ok: false, reason: 'opt_in_required' };
    if (this.busy) return { ok: false, reason: 'install_in_progress' };
    if (this.configError) return { ok: false, reason: this.configError };
    if (this.disposed) return { ok: false, reason: 'image_engine_disposed' };
    if (this._managedPresent()) {
      // Present is not healthy: Install is the repair action, so probe before trusting it.
      this.busy = true;
      let healthy;
      try {
        const probe = await this._probe(path.join(this.root, this.manifest.tag, this.pin.executable));
        healthy = probe?.commit === this.manifest.commit.toLowerCase();
      } finally { this.busy = false; }
      if (healthy) {
        // A healthy engine supersedes the error an earlier failed repair left behind.
        if (this.lastError) { this.lastError = null; this._emit(); }
        return { ok: true };
      }
      if (this.disposed) return { ok: false, reason: 'image_engine_disposed' };
    }
    const op = { cancelled: false, published: false, abortController: new AbortController(), streams: new Set(), child: null };
    const staging = path.join(this.root, `staging-${crypto.randomUUID()}`);
    const extract = path.join(staging, 'extract');
    this.operation = op;
    this.busy = true;
    this.lastError = null;
    this.lastProgressEmit = -Infinity;
    this.progress = { phase: 'downloading', downloaded_bytes: 0,
      total_bytes: this.pin.assets.reduce((sum, asset) => sum + asset.sizeBytes, 0),
      asset_index: 0, asset_count: this.pin.assets.length };
    let stagingCreated = false;
    let result;
    try {
      this._assertRoot(true);
      await this.fsImpl.promises.mkdir(staging);
      stagingCreated = true;
      await this.fsImpl.promises.mkdir(extract);
      this._emit();
      let completedBytes = 0;
      for (const [index, asset] of this.pin.assets.entries()) {
        this._checkCancelled(op);
        this.progress.phase = 'downloading';
        this.progress.asset_index = index;
        const resolved = await this._resolveUrl(asset.url, op);
        this._checkCancelled(op);
        if (!resolved.ok) throw engineError(resolved.reason);
        const wheelPath = path.join(staging, asset.filename);
        const digest = await downloadPinnedFile({ url: resolved.url, destPath: wheelPath,
          expectedBytes: asset.sizeBytes, fetchImpl: this.fetchImpl, fsImpl: this.fsImpl,
          abortController: op.abortController, responseStartTimeoutMs: this.responseStartTimeoutMs,
          inactivityMs: this.inactivityMs, fetchOptions: { redirect: 'error' }, isCancelled: () => op.cancelled,
          onProgress: ({ downloadedBytes }) => {
            this.progress.downloaded_bytes = completedBytes + downloadedBytes;
            const now = this.now();
            if (now - this.lastProgressEmit >= 250) { this.lastProgressEmit = now; this._emit(); }
          } });
        this._checkCancelled(op);
        this._phase('verifying');
        if (digest.toLowerCase() !== asset.sha256.toLowerCase()) {
          await this.fsImpl.promises.rm(wheelPath, { force: true });
          throw engineError('hash_mismatch');
        }
        this._phase('extracting');
        await this.extractImpl({ wheelPath, destDir: extract, limits: this.pin.extractLimits,
          fsImpl: this._extractionFs(op) });
        this._checkCancelled(op);
        completedBytes += asset.sizeBytes;
      }
      if (!this.pin.expectedFiles.every((name) => this._regularFile(path.join(extract, name)))) {
        throw engineError('image_engine_files_missing');
      }
      this._phase('probing');
      this._checkCancelled(op);
      const probe = await this._probe(path.join(extract, this.pin.executable), op);
      this._checkCancelled(op);
      if (!probe || probe.commit !== this.manifest.commit.toLowerCase()) throw engineError('image_engine_probe_failed');
      await this._writeInstallRecord(extract);
      this._checkCancelled(op);
      // No await between the cancellation check and the publication boundary.
      op.published = true;
      this._phase('publishing');
      this._assertRoot();
      await this.fsImpl.promises.rm(path.join(this.root, this.manifest.tag), { recursive: true, force: true });
      await this._renameWithRetry(extract, path.join(this.root, this.manifest.tag));
      await this.fsImpl.promises.rm(staging, { recursive: true, force: true });
      stagingCreated = false;
      this.installedTag = this.manifest.tag;
      // The published record already makes the engine recognisable, so a state write failure is not an install failure.
      try { await this._persist(); }
      catch (_error) { this._log('WARN', 'state_write_failed', { reason: 'image_engine_state_failed' }); }
      this._log('INFO', 'installed', { tag: this.manifest.tag });
      await this._removeSupersededGenerations();
      result = { ok: true };
    } catch (error) {
      const reason = op.cancelled && !op.published ? 'cancelled' : this._errorReason(error)
        || (error.code === 'wheel_invalid' ? 'image_engine_archive_invalid'
          : DOWNLOAD_REASONS.has(error.code) ? error.code
            : !error.code && this.progress.phase === 'extracting' ? 'image_engine_archive_invalid'
              : !error.code && this.progress.phase === 'downloading' ? 'download_failed' : 'image_engine_install_failed');
      this.lastError = reason;
      this._log('WARN', 'install_failed', { reason });
      result = { ok: false, reason };
    } finally {
      if (stagingCreated) {
        try { this._assertRoot(); await this.fsImpl.promises.rm(staging, { recursive: true, force: true }); }
        catch (_error) { this._log('WARN', 'cleanup_failed', { reason: 'image_engine_cleanup_failed' }); }
      }
      this.operation = null;
      this.busy = false;
      this.progress = null;
      this._emit();
    }
    return result;
  }

  // The record rides the publication rename, so the files and their record appear together.
  async _writeInstallRecord(extract) {
    const files = {};
    for (const name of this.pin.expectedFiles) {
      const stat = this.fsImpl.lstatSync(path.join(extract, name));
      if (!stat.isFile() || stat.size <= 0) throw engineError('image_engine_files_missing');
      files[name] = stat.size;
    }
    await this.fsImpl.promises.writeFile(path.join(extract, INSTALL_RECORD), `${JSON.stringify({ version: 1,
      tag: this.manifest.tag, commit: this.manifest.commit, files })}\n`, { flag: 'wx' });
  }

  async _resolveUrl(url, op) {
    let timer;
    try {
      return await Promise.race([resolveReleaseAssetUrl(url, { fetchImpl: this.fetchImpl,
        allowedHosts: GITHUB_UPDATE_HOSTS, abortController: op.abortController }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(engineError('response_timeout'));
          op.abortController.abort();
        }, this.responseStartTimeoutMs);
        timer.unref?.();
      })]);
    } finally { clearTimeout(timer); }
  }

  _checkCancelled(op) {
    if (op.cancelled) throw engineError('cancelled');
  }

  _errorReason(error) {
    return typeof error.reason === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(error.reason) ? error.reason : null;
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

  async cancel() {
    const op = this.operation;
    if (op?.published || (!op && this.installedTag)) return { ok: false, reason: 'install_already_published' };
    if (op) {
      op.cancelled = true;
      op.abortController.abort();
      for (const stream of op.streams) stream.destroy(engineError('cancelled'));
      try { op.child?.kill(); } catch (_error) { /* cancellation still discards the staged output */ }
    }
    return { ok: true };
  }

  async _probe(file, op = null) {
    const output = await new Promise((resolve) => {
      try {
        const child = this.execFileImpl(file, ['--version'], { timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
          windowsHide: true, encoding: 'utf8', cwd: path.dirname(file), env: sanitizeSpawnEnv(process.env) },
        (error, stdout, stderr) => resolve(error ? null : `${stdout || ''}\n${stderr || ''}`.trim()));
        if (op) op.child = child;
      } catch (_error) { resolve(null); }
    });
    if (op) op.child = null;
    const parsed = parseSdCliBanner(output);
    return parsed ? { ...parsed, banner: output } : null;
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

  _sweepStaging() {
    let names;
    try { names = this.fsImpl.readdirSync(this.root); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const name of names) {
      if (!name.startsWith('staging-')) continue;
      const dir = path.join(this.root, name);
      const stat = this.fsImpl.lstatSync(dir);
      if (stat.isDirectory() || stat.isSymbolicLink()) this.fsImpl.rmSync(dir, { recursive: true, force: true });
    }
  }

  // The user's own executable may live inside an older generation; that directory is theirs to keep.
  _holdsCustomExecutable(dir) {
    if (!this.customExecutable) return false;
    const fold = (value) => (this.platform === 'win32' ? value.toLowerCase() : value);
    return fold(path.resolve(this.customExecutable)).startsWith(fold(dir + path.sep));
  }

  // Best effort: only real directories proven to be Jenny-managed generations, never the current tag.
  async _removeSupersededGenerations() {
    let names;
    try {
      this._assertRoot();
      names = this.fsImpl.readdirSync(this.root);
    } catch (_error) { return; }
    for (const name of names) {
      if (name === this.manifest.tag || name.startsWith('staging-') || !DIRECTORY_NAME.test(name)) continue;
      try {
        const dir = path.join(this.root, name);
        const stat = this.fsImpl.lstatSync(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
        if (this._readInstallRecord(dir)?.tag !== name && name !== this.stateTag) continue;
        if (this._holdsCustomExecutable(dir)) continue;
        await this.fsImpl.promises.rm(dir, { recursive: true, force: true });
        this._log('INFO', 'superseded_removed', { tag: name });
      } catch (_error) { this._log('WARN', 'superseded_remove_failed', { tag: name }); }
    }
  }

  async remove(options) {
    if (options?.confirmed !== true) return { ok: false, reason: 'opt_in_required' };
    if (this.busy) return { ok: false, reason: 'install_in_progress' };
    if (this.configError) return { ok: false, reason: this.configError };
    return this._mutate(async () => {
      this._assertRoot();
      await this.fsImpl.promises.rm(path.join(this.root, this.manifest.tag), { recursive: true, force: true });
      this._sweepStaging();
      await this._removeSupersededGenerations();
      this.installedTag = null;
    }, 'image_engine_remove_failed');
  }

  async setCustomExecutable(filePath) {
    if (!isSdCliRuntimePath(filePath, { platform: this.platform })) return { ok: false, reason: 'image_engine_path_rejected' };
    return this._mutate(async () => {
      let stat;
      try { stat = this.fsImpl.statSync(filePath); } catch (_error) { /* reported as a missing path */ }
      if (!stat?.isFile()) throw engineError('image_engine_path_missing');
      const probe = await this._probe(filePath);
      if (!probe) throw engineError('image_engine_probe_failed');
      this.customExecutable = filePath;
      return { banner: probe.banner };
    }, 'image_engine_state_failed');
  }

  async clearCustomExecutable() {
    return this._mutate(async () => { this.customExecutable = null; }, 'image_engine_state_failed');
  }

  async _mutate(action, failureReason) {
    if (this.busy) return { ok: false, reason: 'install_in_progress' };
    if (this.disposed) return { ok: false, reason: 'image_engine_disposed' };
    this.busy = true;
    const previousCustom = this.customExecutable;
    try {
      const result = await action();
      await this._persist();
      this.lastError = this.configError;
      this._emit();
      return { ok: true, ...result };
    } catch (error) {
      this.customExecutable = previousCustom;
      const reason = this._errorReason(error) || failureReason;
      this._log('WARN', 'mutation_failed', { reason });
      return { ok: false, reason };
    } finally { this.busy = false; }
  }

  async _persist() {
    this._assertRoot(true);
    const temp = `${this.stateFile}.${crypto.randomUUID()}.tmp`;
    try {
      await this.fsImpl.promises.writeFile(temp, `${JSON.stringify({ version: 1, installed_tag: this.installedTag,
        custom_executable: this.customExecutable, updated_at: this.now() }, null, 2)}\n`, { flag: 'wx' });
      await this._renameWithRetry(temp, this.stateFile);
    } finally { await this.fsImpl.promises.rm(temp, { force: true }); }
  }

  _phase(phase) { this.progress.phase = phase; this._emit(); }
  _emit() { if (!this.disposed) this.emit('changed', this.getState()); }
  _log(level, event, fields) {
    try { this.logger?.(level, `image_engine.${event}`, fields); } catch (_error) { /* logging is best effort */ }
  }

  dispose() {
    if (this.operation && !this.operation.published) void this.cancel();
    this.disposed = true;
    this.removeAllListeners();
  }
}

module.exports = { ImageEngineService, resolveReleaseAssetUrl, isSdCliRuntimePath, parseSdCliBanner, ENGINE_DIRECTORY };
