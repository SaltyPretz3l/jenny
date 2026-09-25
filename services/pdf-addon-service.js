'use strict';

/**
 * services/pdf-addon-service.js
 *
 * The optional PDF reading add-on: PyMuPDF (AGPL-3.0), which Jenny never
 * bundles. The user installs it from Settings > Tools after a licence
 * disclosure (owner decision 2026-09-22).
 *
 * Trust boundary:
 *  - Only the wheel pinned for this platform in config/pdf-addon-manifest.json
 *    is accepted: https on files.pythonhosted.org, redirects refused, a byte
 *    cap equal to the pinned size, and sha256 verified before extraction.
 *  - Install from a file uses a main-owned open dialog, never a renderer path,
 *    and requires the same size and sha256.
 *  - Install requires `{ licenseAccepted: true }`; nothing downloads without it.
 *  - The wheel is extracted into a staging directory and published by rename
 *    to userData/addons/pdf/<version>/ with the manifest.json the sidecar
 *    checks (sidecar/runtime/media_site.py activate_pdf_addon).
 *
 * State machine: development | unsupported | not_installed | downloading |
 * verifying | installing | ready | failed | load_failed. Cancel works until
 * publishing starts. The sidecar reads the add-on directory from
 * JENNY_SIDECAR_PDF_ADDON_DIR at spawn (sidecarEnv()), so install and remove
 * restart the managed sidecar once no chat is running; while waiting,
 * `applyPending` is true. Remove unsets the directory first and deletes it
 * after the restart, because Windows keeps the loaded .pyd locked; a failed
 * delete is retried at the next start.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');

const DEFAULT_MANIFEST = require('../config/pdf-addon-manifest.json');
const { downloadPinnedFile } = require('./pinned-download');
const { extractWheel } = require('./pdf-addon-wheel');
const { sanitizeSpawnEnv } = require('./backend/sanitize-spawn-env');
const { SIDECAR_ALLOWED_ENV } = require('./backend/sidecar-manager');
const { t } = require('./i18n-main');

const PDF_ADDON_ENV = 'JENNY_SIDECAR_PDF_ADDON_DIR';
const ALLOWED_HOST = 'files.pythonhosted.org';
const STATE_FILE = 'state.json';
const STAGING_PREFIX = 'staging-';
const DIRECTORY_NAME = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const REQUIRED_FILES = [['pymupdf', '__init__.py'], ['fitz', '__init__.py']];
const DISK_ERROR_CODES = new Set(['ENOSPC', 'EACCES', 'EPERM', 'EBUSY', 'EROFS', 'EIO', 'EMFILE', 'EEXIST']);
const RESPONSE_START_TIMEOUT_MS = 30_000;
const DOWNLOAD_INACTIVITY_MS = 60_000;
const PROBE_TIMEOUT_MS = 90_000;
const PROBE_OUTPUT_CAP = 64 * 1024;
const APPLY_POLL_MS = 2_000;
const PROGRESS_INTERVAL_MS = 250;
const RENAME_ATTEMPTS = 4;
const RENAME_RETRY_MS = 500;

function addonError(reason) {
  const error = new Error(reason);
  error.reason = reason;
  return error;
}

function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });
}

function validPin(pin) {
  try {
    const url = new URL(String(pin?.url || ''));
    return url.protocol === 'https:' && url.hostname === ALLOWED_HOST && !url.username && !url.password
      && Number.isSafeInteger(pin.sizeBytes) && pin.sizeBytes > 0
      && /^[0-9a-f]{64}$/.test(String(pin.sha256 || ''))
      && DIRECTORY_NAME.test(String(pin.filename || '')) && url.pathname.endsWith(`/${pin.filename}`);
  } catch (_error) {
    return false;
  }
}

async function copyWithDigest(sourcePath, destPath) {
  const hash = crypto.createHash('sha256');
  const source = fs.createReadStream(sourcePath);
  source.on('data', (chunk) => hash.update(chunk));
  await pipeline(source, fs.createWriteStream(destPath, { flags: 'wx' }));
  return hash.digest('hex');
}

function runSidecarProbe({ command, args, cwd, addonDir, timeoutMs = PROBE_TIMEOUT_MS, spawnImpl = spawn }) {
  const env = {
    ...sanitizeSpawnEnv(process.env, { allow: SIDECAR_ALLOWED_ENV, allowOnly: true }),
    PYTHONUNBUFFERED: '1',
  };
  if (addonDir) env[PDF_ADDON_ENV] = addonDir;
  else delete env[PDF_ADDON_ENV];
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    let child = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child?.kill(); } catch (_error) { /* the timeout result still resolves */ }
      finish({ ok: false, error: 'timeout' });
    }, timeoutMs);
    try {
      child = spawnImpl(command, [...args, '--probe-pdf-addon'], {
        cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch (_error) {
      finish({ ok: false, error: 'spawn_failed' });
      return;
    }
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < PROBE_OUTPUT_CAP) stdout += String(chunk);
    });
    child.once('error', () => finish({ ok: false, error: 'spawn_failed' }));
    child.once('close', () => {
      const line = stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean).pop() || '';
      try {
        const parsed = JSON.parse(line);
        finish(parsed && typeof parsed === 'object' ? parsed : { ok: false, error: 'unparseable' });
      } catch (_error) {
        finish({ ok: false, error: 'unparseable' });
      }
    });
  });
}

class PdfAddonService extends EventEmitter {
  constructor({
    userDataPath,
    isPackaged,
    platform = process.platform,
    arch = process.arch,
    manifest = DEFAULT_MANIFEST,
    fetchImpl = globalThis.fetch,
    getBackend = () => null,
    showOpenDialog = null,
    runProbe = runSidecarProbe,
    logger = () => {},
    applyPollMs = APPLY_POLL_MS,
    responseStartTimeoutMs = RESPONSE_START_TIMEOUT_MS,
    downloadInactivityMs = DOWNLOAD_INACTIVITY_MS,
  }) {
    super();
    Object.assign(this, {
      manifest, fetchImpl, getBackend, showOpenDialog, runProbe, logger,
      applyPollMs, responseStartTimeoutMs, downloadInactivityMs,
    });
    this.isPackaged = isPackaged === true;
    this.root = path.join(userDataPath, 'addons', 'pdf');
    this.stateFile = path.join(this.root, STATE_FILE);
    const pin = manifest?.platforms?.[`${platform}-${arch}`];
    this.pin = validPin(pin) && DIRECTORY_NAME.test(String(manifest.version || '')) ? pin : null;
    this.installed = null;
    this.pendingRemoval = [];
    this.reason = '';
    this.progress = { downloadedBytes: 0, totalBytes: 0 };
    this.applyPending = false;
    this.operation = null;
    this.task = null;
    this.development = null;
    this._lastProgressEmit = 0;
    if (!this.isPackaged) this.phase = 'development';
    else if (!this.pin) this.phase = 'unsupported';
    else this._loadRecord();
  }

  // Synchronous so the first sidecar spawn already sees an installed add-on.
  _loadRecord() {
    let record;
    try {
      record = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) || {};
    } catch (_error) {
      record = {};
    }
    this.pendingRemoval = (Array.isArray(record.pendingRemoval) ? record.pendingRemoval : [])
      .filter((name) => typeof name === 'string' && DIRECTORY_NAME.test(name));
    const recorded = typeof record.installedVersion === 'string' && DIRECTORY_NAME.test(record.installedVersion)
      ? record.installedVersion : '';
    // Only the version this build pins counts; an add-on left by another build
    // is removed at start and set up again with this build's pin and licence.
    const version = recorded === this.manifest.version ? recorded : '';
    if (recorded && !version && !this.pendingRemoval.includes(recorded)) this.pendingRemoval.push(recorded);
    const dir = version ? path.join(this.root, version) : '';
    if (dir && !this.pendingRemoval.includes(version) && fs.existsSync(path.join(dir, 'manifest.json'))) {
      this.installed = { version, dir, probe: record.probe === 'failed' ? 'failed' : 'ok' };
    }
    this.phase = this.installed ? (this.installed.probe === 'failed' ? 'load_failed' : 'ready') : 'not_installed';
  }

  getState() {
    if (this.phase === 'development') this._checkDevelopment();
    const manifest = this.manifest || {};
    return {
      state: this.phase,
      reason: this.reason,
      package: String(manifest.package || ''),
      version: String(manifest.version || ''),
      license: String(manifest.license || ''),
      licenseUrl: String(manifest.licenseUrl || ''),
      installedVersion: this.installed?.version || '',
      downloadSizeBytes: this.pin?.sizeBytes || 0,
      installedSizeBytes: Number(manifest.installedSizeBytes) || 0,
      downloadedBytes: this.progress.downloadedBytes,
      totalBytes: this.progress.totalBytes,
      applyPending: this.applyPending,
      cancellable: Boolean(this.operation?.cancellable && !this.operation.published),
      developmentAvailable: this.development?.available ?? null,
      developmentVersion: this.development?.version || '',
    };
  }

  // Env for the managed sidecar spawn. An empty value tells SidecarManager to
  // drop an inherited key; development builds leave the environment alone.
  sidecarEnv() {
    if (this.phase === 'development') return {};
    return { [PDF_ADDON_ENV]: this.installed?.dir || '' };
  }

  async start() {
    if (this.phase === 'development' || this.phase === 'unsupported') return this.getState();
    let names;
    try {
      names = await fs.promises.readdir(this.root);
    } catch (_error) {
      return this.getState();
    }
    for (const name of names) {
      if (name.startsWith(STAGING_PREFIX) && !this.operation) {
        await fs.promises.rm(path.join(this.root, name), { recursive: true, force: true }).catch(() => {});
      }
    }
    await this._removePending();
    return this.getState();
  }

  install(payload) {
    this._assertCanInstall(payload);
    const op = this._claim({ cancellable: true });
    this._startTask(this._runInstall(op, 'downloading', async (stagingDir) => {
      const wheelPath = path.join(stagingDir, this.pin.filename);
      const digest = await downloadPinnedFile({
        url: this.pin.url,
        destPath: wheelPath,
        expectedBytes: this.pin.sizeBytes,
        fetchImpl: this.fetchImpl,
        abortController: op.abortController,
        responseStartTimeoutMs: this.responseStartTimeoutMs,
        inactivityMs: this.downloadInactivityMs,
        fetchOptions: { redirect: 'error' },
        isCancelled: () => op.cancelled,
        onProgress: (progress) => this._setProgress(progress),
      });
      this._setPhase('verifying');
      if (digest !== this.pin.sha256) throw addonError('fingerprint');
      return wheelPath;
    }));
    return this.getState();
  }

  async installFromFile(payload) {
    this._assertCanInstall(payload);
    if (typeof this.showOpenDialog !== 'function') throw addonError('dialog_unavailable');
    const op = this._claim({ cancellable: true });
    // One task from the dialog to the end of the install, so whenSettled()
    // also waits while the picker is open.
    const picking = this._pickWheel();
    this._startTask(picking.then((sourcePath) => {
      if (!sourcePath || op.cancelled) {
        this.operation = null;
        return undefined;
      }
      return this._installFromPath(op, sourcePath);
    }));
    await picking;
    return this.getState();
  }

  async _pickWheel() {
    try {
      const picked = await this.showOpenDialog({
        title: t('main.dialog.pdfAddon.chooseWheel', 'Choose the PyMuPDF wheel'),
        properties: ['openFile'],
        filters: [{ name: t('main.dialog.pdfAddon.wheelFilter', 'Python wheel'), extensions: ['whl'] }],
      });
      return !picked?.canceled && Array.isArray(picked?.filePaths) ? String(picked.filePaths[0] || '') : '';
    } catch (_error) {
      return '';
    }
  }

  _installFromPath(op, sourcePath) {
    return this._runInstall(op, 'verifying', async (stagingDir) => {
      const stat = await fs.promises.stat(sourcePath).catch(() => null);
      if (!stat?.isFile() || stat.size !== this.pin.sizeBytes) throw addonError('wrong_file');
      const wheelPath = path.join(stagingDir, this.pin.filename);
      const digest = await copyWithDigest(sourcePath, wheelPath);
      if (digest !== this.pin.sha256) throw addonError('wrong_file');
      return wheelPath;
    });
  }

  cancel() {
    const op = this.operation;
    if (op?.cancellable && !op.published) {
      op.cancelled = true;
      op.abortController.abort();
    }
    return this.getState();
  }

  remove() {
    if (this.operation || !this.installed || !['ready', 'load_failed'].includes(this.phase)) {
      throw addonError('pdf_addon_busy');
    }
    const op = this._claim({ cancellable: false });
    const previous = { installed: this.installed, pendingRemoval: [...this.pendingRemoval], phase: this.phase };
    const { version } = this.installed;
    this.installed = null;
    if (!this.pendingRemoval.includes(version)) this.pendingRemoval.push(version);
    this.reason = '';
    this._setPhase('not_installed');
    this._startTask((async () => {
      let persisted = false;
      try {
        await this._persist();
        persisted = true;
        await this._apply('removed');
        await this._removePending();
      } catch (error) {
        // Unsaved, the removal would quietly undo itself at the next start.
        if (!persisted) Object.assign(this, previous);
        this._log('WARN', 'pdf_addon.remove_failed', { message: String(error?.message || error).slice(0, 200) });
      } finally {
        this.operation = null;
        this._emit();
      }
    })());
    return this.getState();
  }

  // Resolves when the current install or remove (including its sidecar
  // restart) has settled. Tests and shutdown use it; the UI follows `changed`.
  whenSettled() {
    return this.task || Promise.resolve();
  }

  _assertCanInstall(payload) {
    if (!payload || Object.keys(payload).length !== 1 || payload.licenseAccepted !== true) {
      throw addonError('licence_not_accepted');
    }
    if (this.operation || !['not_installed', 'failed'].includes(this.phase)) throw addonError('pdf_addon_busy');
  }

  _claim({ cancellable }) {
    const op = { cancellable, cancelled: false, published: false, abortController: new AbortController() };
    this.operation = op;
    return op;
  }

  _startTask(promise) {
    const tracked = promise.finally(() => { if (this.task === tracked) this.task = null; });
    this.task = tracked;
  }

  async _runInstall(op, firstPhase, acquireWheel) {
    const stagingDir = path.join(this.root, `${STAGING_PREFIX}${crypto.randomUUID()}`);
    this.reason = '';
    this.progress = { downloadedBytes: 0, totalBytes: 0 };
    this._setPhase(firstPhase);
    try {
      await fs.promises.mkdir(stagingDir, { recursive: true });
      const wheelPath = await acquireWheel(stagingDir);
      if (op.cancelled) throw addonError('cancelled');
      this._setPhase('installing');
      const siteDir = path.join(stagingDir, 'site');
      await fs.promises.mkdir(siteDir);
      await extractWheel({ wheelPath, destDir: siteDir });
      for (const parts of REQUIRED_FILES) {
        if (!fs.existsSync(path.join(siteDir, ...parts))) throw addonError('install_failed');
      }
      await fs.promises.writeFile(path.join(siteDir, 'manifest.json'), `${JSON.stringify({
        package: this.manifest.package,
        version: this.manifest.version,
        minimum_python_version: this.manifest.minimumPythonVersion,
      }, null, 2)}\n`, { flag: 'wx' });
      if (op.cancelled) throw addonError('cancelled');
      // No await between the check and here: from now on Cancel is refused.
      op.published = true;
      this._emit();
      const version = this.manifest.version;
      const target = path.join(this.root, version);
      await fs.promises.rm(target, { recursive: true, force: true });
      await this._renameWithRetry(siteDir, target);
      this.pendingRemoval = this.pendingRemoval.filter((name) => name !== version);
      this.installed = { version, dir: target, probe: 'ok' };
      await this._persist();
      this.installed.probe = await this._probe(target);
      await this._persist();
      await this._apply('installed');
      this._setPhase(this.installed.probe === 'failed' ? 'load_failed' : 'ready');
    } catch (error) {
      if (op.cancelled && !op.published) {
        this.reason = '';
        this._setPhase('not_installed');
      } else {
        this.reason = this._failureReason(error);
        this._log('WARN', 'pdf_addon.install_failed', {
          reason: this.reason,
          code: String(error?.code || ''),
          message: String(error?.message || error).slice(0, 200),
        });
        if (this.installed) this._setPhase('load_failed');
        else this._setPhase('failed');
      }
    } finally {
      await fs.promises.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      this.operation = null;
      this.progress = { downloadedBytes: 0, totalBytes: 0 };
      this._emit();
    }
  }

  _failureReason(error) {
    if (error?.reason) return error.reason;
    const code = String(error?.code || '');
    if (code === 'wheel_invalid') return 'install_failed';
    if (DISK_ERROR_CODES.has(code)) return 'disk';
    if (this.phase === 'downloading') {
      return code === 'byte_overflow' || code === 'size_mismatch' ? 'fingerprint' : 'network';
    }
    return 'install_failed';
  }

  async _renameWithRetry(from, to) {
    // Windows antivirus can hold freshly written .pyd/.dll files for a moment.
    for (let attempt = 1; ; attempt += 1) {
      try {
        await fs.promises.rename(from, to);
        return;
      } catch (error) {
        if (attempt >= RENAME_ATTEMPTS || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) throw error;
        await delay(RENAME_RETRY_MS);
      }
    }
  }

  async _probe(addonDir) {
    const launch = this._probeLaunch();
    if (!launch) return 'ok';
    const result = await this.runProbe({ ...launch, addonDir });
    this._log(result?.ok === true ? 'INFO' : 'WARN', 'pdf_addon.probe', {
      ok: result?.ok === true,
      error: String(result?.error || '').slice(0, 80),
      version: String(result?.version || '').slice(0, 40),
    });
    return result?.ok === true ? 'ok' : 'failed';
  }

  // The same executable the managed sidecar runs: the verified packaged binary,
  // or the dev interpreter with `-m sidecar`. Packaged launch resolution happens
  // at the first sidecar start; before that there is nothing to probe with.
  _probeLaunch() {
    const manager = this.getBackend()?.sidecarManager;
    if (!manager) return null;
    const packaged = manager.packagedSidecarLaunch;
    if (packaged) {
      return packaged.ok === true
        ? { command: packaged.launchCommand, args: [...(packaged.launchArgs || [])], cwd: manager.repoRoot }
        : null;
    }
    if (this.isPackaged || !manager.launchCommand) return null;
    return { command: manager.launchCommand, args: [...(manager.launchArgs || ['-m', 'sidecar'])], cwd: manager.repoRoot };
  }

  _checkDevelopment() {
    if (this.development) return;
    this.development = { available: null, version: '' };
    const launch = this._probeLaunch();
    if (!launch) {
      this.development = null;
      return;
    }
    void Promise.resolve(this.runProbe({ ...launch, addonDir: '' })).then((result) => {
      this.development = { available: result?.ok === true, version: String(result?.version || '').slice(0, 40) };
      this._emit();
    }, () => {
      this.development = { available: false, version: '' };
      this._emit();
    });
  }

  _isIdle(backend) {
    let runtimeBusy;
    try {
      // Paused or queued replies and quarantined leases survive a sidecar
      // restart, so only a turn that is producing holds the apply (F23).
      runtimeBusy = backend.sessionRuntime != null && backend.sessionRuntime.hasProducingWork?.() !== false;
    } catch (_error) {
      runtimeBusy = true;
    }
    return !(backend.activeStreams?.size > 0) && !runtimeBusy;
  }

  // Restart the managed sidecar so it spawns with the new sidecarEnv(), but
  // never mid-turn. A sidecar that is not running picks the env up at its
  // next spawn, so there is nothing to apply.
  async _apply(reason) {
    this.applyPending = true;
    this._emit();
    try {
      for (;;) {
        const backend = this.getBackend();
        const manager = backend?.sidecarManager;
        const phase = manager?.process ? String(manager.getStatus?.()?.phase || '') : '';
        if (!['ready', 'starting', 'stopping'].includes(phase)) return;
        if (typeof backend._restartManagedSidecar !== 'function') return;
        if (phase === 'ready' && this._isIdle(backend)) {
          const restarted = await backend._restartManagedSidecar(`pdf_addon_${reason}`);
          if (restarted !== true) this._log('WARN', 'pdf_addon.apply_restart_failed', { reason });
          return;
        }
        await delay(this.applyPollMs);
      }
    } finally {
      this.applyPending = false;
    }
  }

  async _removePending() {
    const remaining = [];
    for (const name of this.pendingRemoval) {
      if (name === this.installed?.version) continue;
      try {
        await fs.promises.rm(path.join(this.root, name), { recursive: true, force: true });
      } catch (error) {
        remaining.push(name);
        this._log('WARN', 'pdf_addon.remove_deferred', { code: String(error?.code || '') });
      }
    }
    if (remaining.length !== this.pendingRemoval.length) {
      this.pendingRemoval = remaining;
      await this._persist().catch(() => {});
    }
  }

  async _persist() {
    await fs.promises.mkdir(this.root, { recursive: true });
    const temp = `${this.stateFile}.${process.pid}.tmp`;
    await fs.promises.writeFile(temp, `${JSON.stringify({
      schema: 1,
      installedVersion: this.installed?.version || null,
      probe: this.installed?.probe || null,
      pendingRemoval: this.pendingRemoval,
    }, null, 2)}\n`);
    await fs.promises.rename(temp, this.stateFile);
  }

  _setPhase(phase) {
    this.phase = phase;
    this._emit();
  }

  _setProgress({ downloadedBytes, totalBytes }) {
    this.progress = { downloadedBytes, totalBytes };
    const now = Date.now();
    if (downloadedBytes === totalBytes || now - this._lastProgressEmit >= PROGRESS_INTERVAL_MS) {
      this._lastProgressEmit = now;
      this._emit();
    }
  }

  _emit() {
    this.emit('changed', this.getState());
  }

  _log(level, event, data) {
    try { this.logger(level, event, data); } catch (_error) { /* logging never breaks the add-on */ }
  }
}

module.exports = { PDF_ADDON_ENV, PdfAddonService, runSidecarProbe };
