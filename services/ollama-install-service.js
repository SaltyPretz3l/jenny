'use strict';

/**
 * services/ollama-install-service.js
 *
 * Transparent, OPT-IN download + install of the official Ollama runtime for the
 * onboarding flow. Kept separate from SetupService so the network/download/spawn/
 * hash-verify surface is isolated and fully mockable in unit tests.
 *
 * Transparency + safety contract:
 *  - getInstallPlan() returns the pinned URL/version/size/SHA256 from a committed
 *    provenance manifest with NO network call, so the renderer can show the exact
 *    source + size + hash BEFORE the user opts in.
 *  - installOllama() requires `confirmed === true`; there is no code path that
 *    downloads anything without it (returns code 'opt_in_required' otherwise).
 *  - The download is SHA256-verified against the manifest and FAILS CLOSED
 *    (deletes the temp file, never runs the installer) on mismatch.
 *  - Any failure surfaces a manualFallbackUrl (ollama.com/download).
 *
 * Does NOT touch OLLAMA_* runtime env (anti-thrash settings are owned by
 * ollama-process-manager / ollama-env). The OS installer sets none of those.
 */

const path = require('path');
const { EventEmitter } = require('events');
const { spawn: defaultSpawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

const { normalizeString } = require('./backend/path-utils');
const { killProcessTree } = require('./backend/process-utils');
const { SETUP_ERROR_CODES } = require('./backend/error-codes');
const { ollamaInstallDirs } = require('./ollama-runtime-paths');
const { createRequestId, normalizeRequestId } = require('./setup-service-helpers');

const INSTALLER_SILENT_ARGS = Object.freeze(['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART']);
const FALLBACK_URLS_BY_PLATFORM = Object.freeze({
  win32: 'https://ollama.com/download/windows',
  darwin: 'https://ollama.com/download/mac',
  linux: 'https://ollama.com/download/linux',
});
const GENERIC_FALLBACK_URL = 'https://ollama.com/download';

function defaultOllamaFallbackUrl(platform) {
  return FALLBACK_URLS_BY_PLATFORM[normalizeString(platform)] || GENERIC_FALLBACK_URL;
}
const RESPONSE_START_TIMEOUT_MS = 30_000;
const DOWNLOAD_INACTIVITY_MS = 60_000;
const INSTALLER_TIMEOUT_MS = 10 * 60 * 1000;
const POST_INSTALL_READINESS_TIMEOUT_MS = 30_000;
const TERMINATION_TIMEOUT_MS = 5_000;
const PROGRESS_INTERVAL_MS = 250;

function boundedError(value) {
  return String(value || '')
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s:"']+[\\/])+[^\s:"']*/g, '[path]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .trim()
    .slice(0, 300);
}

function installError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function isHttpsUrl(value) {
  try {
    return new URL(value).protocol === 'https:';
  } catch (_error) {
    return false;
  }
}

class OllamaInstallService extends EventEmitter {
  constructor({
    manifest = {},
    fetchImpl = globalThis.fetch,
    spawnImpl = defaultSpawn,
    fsImpl = fs,
    cryptoImpl = crypto,
    tmpDirProvider = () => os.tmpdir(),
    detectImpl = null,
    restartImpl = null,
    delayImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    platform = process.platform,
    env = process.env,
    requestIdProvider = createRequestId,
    killProcessTreeImpl = killProcessTree,
    responseStartTimeoutMs = RESPONSE_START_TIMEOUT_MS,
    downloadInactivityMs = DOWNLOAD_INACTIVITY_MS,
    installerTimeoutMs = INSTALLER_TIMEOUT_MS,
    postInstallReadinessTimeoutMs = POST_INSTALL_READINESS_TIMEOUT_MS,
    terminationTimeoutMs = TERMINATION_TIMEOUT_MS,
    logger = () => {},
  } = {}) {
    super();
    this.manifest = manifest && typeof manifest === 'object' ? manifest : {};
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : null;
    this.spawnImpl = typeof spawnImpl === 'function' ? spawnImpl : defaultSpawn;
    this.fsImpl = fsImpl || fs;
    this.cryptoImpl = cryptoImpl || crypto;
    this.tmpDirProvider = typeof tmpDirProvider === 'function' ? tmpDirProvider : () => os.tmpdir();
    this.detectImpl = typeof detectImpl === 'function' ? detectImpl : null;
    this.restartImpl = typeof restartImpl === 'function' ? restartImpl : null;
    this.delayImpl = typeof delayImpl === 'function' ? delayImpl : (ms) => new Promise((r) => setTimeout(r, ms));
    this.platform = normalizeString(platform) || process.platform;
    this.defaultFallbackUrl = defaultOllamaFallbackUrl(this.platform);
    this.env = env && typeof env === 'object' ? env : process.env;
    this.requestIdProvider = typeof requestIdProvider === 'function' ? requestIdProvider : createRequestId;
    this.logger = typeof logger === 'function' ? logger : () => {};
    this.killProcessTreeImpl = killProcessTreeImpl;
    this.responseStartTimeoutMs = Math.max(1, Number(responseStartTimeoutMs) || RESPONSE_START_TIMEOUT_MS);
    this.downloadInactivityMs = Math.max(1, Number(downloadInactivityMs) || DOWNLOAD_INACTIVITY_MS);
    this.installerTimeoutMs = Math.max(1, Number(installerTimeoutMs) || INSTALLER_TIMEOUT_MS);
    this.postInstallReadinessTimeoutMs = Math.max(
      1,
      Number(postInstallReadinessTimeoutMs) || POST_INSTALL_READINESS_TIMEOUT_MS
    );
    this.terminationTimeoutMs = Math.max(1, Number(terminationTimeoutMs) || TERMINATION_TIMEOUT_MS);
    this._active = new Map();
    this._activeOperation = null;
  }

  _log(level, event, data) {
    try {
      this.logger(level, event, data || {});
    } catch (_error) {
      // logging must never throw
    }
  }

  getInstallPlan() {
    const m = this.manifest || {};
    const url = normalizeString(m.url);
    const version = normalizeString(m.version);
    const minimumVersion = normalizeString(m.minimumSupportedVersion) || version;
    const sha256 = normalizeString(m.sha256);
    const manualFallbackUrl = this.platform === 'win32'
      ? (normalizeString(m.manualFallbackUrl) || this.defaultFallbackUrl)
      : this.defaultFallbackUrl;
    const parsedSize = Number(m.sizeBytes);
    const sizeBytes = Number.isSafeInteger(parsedSize) && parsedSize > 0 ? parsedSize : 0;
    const available = this.platform === 'win32'
      && Boolean(version && sizeBytes)
      && isHttpsUrl(url)
      && /^[a-f0-9]{64}$/i.test(sha256);
    return {
      available,
      url,
      version,
      minimumVersion,
      sizeBytes,
      sha256,
      license: normalizeString(m.license),
      manualFallbackUrl,
    };
  }

  _public(entry) {
    return {
      requestId: entry.requestId,
      status: entry.status,
      phase: entry.phase,
      percent: Number.isFinite(entry.percent) ? entry.percent : 0,
      downloadedBytes: Number.isFinite(entry.downloadedBytes) ? entry.downloadedBytes : 0,
      totalBytes: Number.isFinite(entry.totalBytes) ? entry.totalBytes : 0,
      summary: entry.summary || '',
      code: entry.code || '',
      error: boundedError(entry.error),
      manualFallbackUrl: entry.manualFallbackUrl || this.defaultFallbackUrl,
    };
  }

  _emit(entry, phase, { terminal = false } = {}) {
    if (phase) {
      entry.phase = phase;
    }
    const now = Date.now();
    if (!terminal && entry.lastEmitAt && now - entry.lastEmitAt < PROGRESS_INTERVAL_MS) return;
    entry.lastEmitAt = now;
    this.emit('install-progress', this._public(entry));
  }

  _finish(entry, patch = {}) {
    if (entry.finished) {
      return this._public(entry);
    }
    entry.finished = true;
    entry.status = patch.status || entry.status;
    entry.code = patch.code || entry.code;
    entry.summary = patch.summary || entry.summary;
    if (patch.error) entry.error = boundedError(patch.error);
    if (patch.manualFallbackUrl) {
      entry.manualFallbackUrl = patch.manualFallbackUrl;
    }
    this._active.delete(entry.requestId);
    if (this._activeOperation === entry) this._activeOperation = null;
    this._emit(entry, entry.status, { terminal: true });
    this._log(entry.status === 'completed' ? 'INFO' : 'WARN', 'ollama_install.finished', {
      requestId: entry.requestId,
      status: entry.status,
      code: entry.code,
      error: entry.error,
    });
    const publicState = this._public(entry);
    entry.resolveSettlement?.(publicState);
    entry.resolveSettlement = null;
    return publicState;
  }

  _safeCleanup(entry) {
    try {
      if (entry?.tempDir && typeof this.fsImpl.rmSync === 'function') {
        this.fsImpl.rmSync(entry.tempDir, { recursive: true, force: true });
      } else if (entry?.destPath && typeof this.fsImpl.unlinkSync === 'function') {
        this.fsImpl.unlinkSync(entry.destPath);
      }
    } catch (_error) {
      // best-effort cleanup
    }
  }

  _createTempTarget() {
    if (typeof this.fsImpl.mkdtempSync !== 'function') {
      throw installError('temp_create_failed', 'A secure temporary directory could not be created.');
    }
    const tempDir = this.fsImpl.mkdtempSync(path.join(this.tmpDirProvider(), 'jenny-ollama-'));
    return { tempDir, destPath: path.join(tempDir, 'OllamaSetup.exe') };
  }

  _isCompatibleDetection(detected) {
    if (!detected || detected.installed !== true || detected.upgradeRequired === true) {
      return false;
    }
    if (detected.versionSupported === true) {
      return true;
    }
    return detected.versionStatus === 'unverified' && detected.running === true;
  }

  _isReadyDetection(detected) {
    return detected?.running === true && this._isCompatibleDetection(detected);
  }

  async _detectWithin(timeoutMs) {
    let timer = null;
    try {
      return await Promise.race([
        Promise.resolve().then(() => this.detectImpl()),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(installError('readiness_timeout', 'Ollama readiness probe timed out.')),
            Math.max(1, timeoutMs)
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async _download(url, destPath, entry, expectedBytes) {
    entry.abortController = typeof AbortController === 'function' ? new AbortController() : null;
    let responseTimer = null;
    const responseTimeout = new Promise((_, reject) => {
      responseTimer = setTimeout(() => {
        entry.abortController?.abort();
        reject(installError('response_timeout', 'The installer server did not respond in time.'));
      }, this.responseStartTimeoutMs);
      responseTimer.unref?.();
    });
    let response;
    try {
      response = await Promise.race([
        this.fetchImpl(url, {
          method: 'GET',
          ...(entry.abortController ? { signal: entry.abortController.signal } : {}),
        }),
        responseTimeout,
      ]);
    } finally {
      if (responseTimer) clearTimeout(responseTimer);
    }
    if (!response || response.ok !== true) {
      throw installError('download_failed', `Download failed (HTTP ${response?.status || 0}).`);
    }
    const headerTotal = Number(response.headers?.get?.('content-length') || 0);
    if (headerTotal > expectedBytes) {
      entry.abortController?.abort();
      throw installError('byte_overflow', 'Installer response exceeds the pinned artifact size.');
    }
    const hash = this.cryptoImpl.createHash('sha256');
    const out = this.fsImpl.createWriteStream(destPath, { flags: 'wx' });
    let downloaded = 0;
    let outputError = null;
    let inactivityTimer = null;
    let inactivityTriggered = false;
    const resetInactivity = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        inactivityTriggered = true;
        entry.abortController?.abort();
      }, this.downloadInactivityMs);
      inactivityTimer.unref?.();
    };
    out?.on?.('error', (error) => { outputError = error; });
    const consumeChunk = async (chunk) => {
      if (outputError) throw outputError;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      downloaded += buffer.length;
      if (downloaded > expectedBytes) {
        entry.abortController?.abort();
        throw installError('byte_overflow', 'Installer download exceeded the pinned artifact size.');
      }
      resetInactivity();
      hash.update(buffer);
      if (out.write(buffer) === false) {
        await new Promise((resolve, reject) => {
          out.once?.('drain', resolve);
          out.once?.('error', reject);
        });
      }
      entry.downloadedBytes = downloaded;
      entry.totalBytes = expectedBytes;
      entry.percent = Math.min(Math.round((downloaded / expectedBytes) * 100), 100);
      this._emit(entry, 'downloading');
    };
    let completed = false;
    try {
      resetInactivity();
      if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
        for await (const chunk of response.body) {
          if (entry.abortController?.signal?.aborted) {
            throw installError(entry.cancelled ? 'cancelled' : 'download_inactivity', 'Installer download stopped.');
          }
          await consumeChunk(chunk);
        }
      } else if (typeof response.arrayBuffer === 'function') {
        const buffer = Buffer.from(await response.arrayBuffer());
        if (entry.abortController?.signal?.aborted) {
          throw installError(entry.cancelled ? 'cancelled' : 'download_inactivity', 'Installer download stopped.');
        }
        await consumeChunk(buffer);
      } else {
        throw installError('download_failed', 'Download response had no readable body.');
      }
      if (entry.abortController?.signal?.aborted) {
        throw installError(entry.cancelled ? 'cancelled' : 'download_inactivity', 'Installer download stopped.');
      }
      if (downloaded !== expectedBytes) {
        throw installError('size_mismatch', 'Installer size did not match the pinned artifact.');
      }
      if (outputError) throw outputError;
      await new Promise((resolve, reject) => {
        out.on?.('error', reject);
        out.end(resolve);
      });
      completed = true;
    } catch (error) {
      if (inactivityTriggered && !entry.cancelled) {
        throw installError('download_inactivity', 'Installer download stalled.');
      }
      throw error;
    } finally {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      entry.abortController = null;
      if (!completed) out.destroy?.();
    }
    return hash.digest('hex');
  }

  async _terminateEntry(entry) {
    entry.abortController?.abort();
    const pid = Number(entry.child?.pid);
    if (!Number.isInteger(pid) || pid <= 0) {
      try { entry.child?.kill?.(); } catch (_error) { /* reported as unconfirmed */ }
      return false;
    }
    try {
      const result = await this.killProcessTreeImpl(pid, {
        force: true,
        confirmExit: true,
        timeoutMs: this.terminationTimeoutMs,
        platform: this.platform,
      });
      return result?.terminated === true;
    } catch (_error) {
      return false;
    }
  }

  _runInstaller(installerPath, entry) {
    return new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let timedOut = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        callback(value);
      };
      try {
        child = this.spawnImpl(installerPath, INSTALLER_SILENT_ARGS.slice(), { windowsHide: true });
      } catch (error) {
        reject(error);
        return;
      }
      entry.child = child;
      const clearOwnedChild = () => {
        if (entry.child === child) entry.child = null;
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        void this._terminateEntry(entry).then((confirmed) => {
          const error = installError('installer_timeout', 'The Ollama installer timed out.');
          error.terminationConfirmed = confirmed;
          settle(reject, error);
        });
      }, this.installerTimeoutMs);
      timeout.unref?.();
      if (child && typeof child.once === 'function') {
        child.once('error', (error) => {
          clearOwnedChild();
          if (timedOut) return;
          clearTimeout(timeout);
          settle(reject, error);
        });
        child.once('exit', (code) => {
          clearOwnedChild();
          if (timedOut) return;
          clearTimeout(timeout);
          entry.terminationConfirmed = entry.cancelled === true;
          settle(resolve, typeof code === 'number' && Number.isFinite(code) ? code : 1);
        });
      } else {
        clearTimeout(timeout);
        settle(resolve, 1);
      }
    });
  }

  async _reprobe(entry) {
    if (!this.detectImpl) {
      return false;
    }
    const deadline = Date.now() + this.postInstallReadinessTimeoutMs;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (entry?.cancelled) return false;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      try {
        const detected = await this._detectWithin(remaining);
        if (this._isReadyDetection(detected)) {
          return true;
        }
      } catch (_error) {
        // keep retrying
      }
      const delayMs = Math.min(1000, Math.max(deadline - Date.now(), 0));
      if (delayMs > 0) await this.delayImpl(delayMs);
    }
    return false;
  }

  /**
   * Download + verify + silently install Ollama. Requires explicit opt-in.
   * Streams 'install-progress' events; resolves to the terminal public state.
   */
  async installOllama({ confirmed, requestId } = {}) {
    const plan = this.getInstallPlan();
    const id = normalizeRequestId(requestId)
      || normalizeRequestId(this.requestIdProvider())
      || createRequestId();
    const existing = this._activeOperation || this._active.get(id);
    if (existing) {
      this._log('INFO', 'ollama_install.duplicate_request_coalesced', {
        requestId: existing.requestId,
        adoptedRequestId: id,
        phase: existing.phase,
      });
      return this._public(existing);
    }
    const entry = {
      requestId: id,
      status: 'queued',
      phase: 'queued',
      percent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      summary: '',
      code: '',
      error: '',
      manualFallbackUrl: plan.manualFallbackUrl,
      cancelled: false,
      finished: false,
      child: null,
      abortController: null,
      terminationPromise: null,
      terminationConfirmed: false,
      lastEmitAt: 0,
    };
    entry.settlement = new Promise((resolve) => { entry.resolveSettlement = resolve; });
    this._active.set(id, entry);
    this._activeOperation = entry;

    if (confirmed !== true) {
      return this._finish(entry, {
        status: 'failed',
        code: 'opt_in_required',
        summary: 'Explicit opt-in is required before downloading Ollama.',
      });
    }
    if (!plan.available || !this.fetchImpl) {
      return this._finish(entry, {
        status: 'failed',
        code: 'not_configured',
        summary: 'Automatic Ollama install is not available. Install it manually from ollama.com.',
      });
    }

    // Already installed? Short-circuit without downloading anything.
    let upgradeRequired = false;
    if (this.detectImpl) {
      try {
        const detected = await this._detectWithin(this.postInstallReadinessTimeoutMs);
        upgradeRequired = detected?.upgradeRequired === true;
        if (this._isCompatibleDetection(detected)) {
          return this._finish(entry, {
            status: 'completed',
            code: 'already_installed',
            summary: 'Ollama is already installed.',
          });
        }
      } catch (_error) {
        // proceed with install
      }
    }
    if (entry.cancelled) {
      entry.terminationConfirmed = true;
      return this._finish(entry, { status: 'cancelled', code: 'cancelled', summary: 'Install cancelled.' });
    }

    let tempTarget;
    try {
      tempTarget = this._createTempTarget();
      entry.tempDir = tempTarget.tempDir;
      entry.destPath = tempTarget.destPath;
    } catch (_error) {
      return this._finish(entry, {
        status: 'failed', code: 'temp_create_failed', summary: 'A secure temporary installer file could not be created.',
      });
    }

    // Download (streamed progress).
    let digest;
    try {
      entry.status = 'running';
      this._emit(entry, 'downloading');
      digest = await this._download(plan.url, entry.destPath, entry, plan.sizeBytes);
    } catch (error) {
      this._safeCleanup(entry);
      if (entry.cancelled || (error && error.code === 'cancelled')) {
        entry.terminationConfirmed = true;
        return this._finish(entry, { status: 'cancelled', code: 'cancelled', summary: 'Install cancelled.' });
      }
      return this._finish(entry, {
        status: 'failed',
        code: (error && error.code) || 'download_failed',
        summary: 'Download failed. Install Ollama manually from ollama.com.',
        error: String((error && error.message) || error),
      });
    }

    if (entry.cancelled) {
      this._safeCleanup(entry);
      entry.terminationConfirmed = true;
      return this._finish(entry, { status: 'cancelled', code: 'cancelled', summary: 'Install cancelled.' });
    }

    // Verify SHA256 — FAIL CLOSED on mismatch (never run an unverified installer).
    this._emit(entry, 'verifying');
    if (String(digest).toLowerCase() !== String(plan.sha256).toLowerCase()) {
      this._safeCleanup(entry);
      return this._finish(entry, {
        status: 'failed',
        code: 'hash_mismatch',
        summary: 'Downloaded installer failed its integrity check and was deleted.',
        error: `expected ${plan.sha256}, got ${digest}`,
      });
    }

    // Install (silent, per-user; no admin for Ollama's Inno Setup installer).
    this._emit(entry, 'installing');
    let exitCode;
    try {
      exitCode = await this._runInstaller(entry.destPath, entry);
    } catch (error) {
      this._safeCleanup(entry);
      if (entry.cancelled || (error && error.code === 'cancelled')) {
        if (entry.terminationPromise) {
          entry.terminationConfirmed = await entry.terminationPromise;
        }
        return this._finish(entry, entry.terminationConfirmed
          ? { status: 'cancelled', code: 'cancelled', summary: 'Install cancelled.' }
          : {
              status: 'failed', code: 'termination_failed',
              summary: 'The installer could not be confirmed stopped.',
              error: 'Process termination was not confirmed.',
            });
      }
      if (typeof error?.terminationConfirmed === 'boolean') {
        entry.terminationConfirmed = error.terminationConfirmed;
      }
      const terminationFailed = error?.code === 'installer_timeout'
        && error?.terminationConfirmed === false;
      return this._finish(entry, {
        status: 'failed',
        code: terminationFailed ? 'termination_failed' : (error?.code || 'installer_failed'),
        summary: terminationFailed
          ? 'The timed-out Ollama installer could not be confirmed stopped.'
          : error?.code === 'installer_timeout'
            ? 'The Ollama installer timed out.'
          : 'The Ollama installer could not be launched.',
        error: String((error && error.message) || error),
      });
    }
    this._safeCleanup(entry);

    if (entry.cancelled) {
      if (entry.terminationPromise) {
        entry.terminationConfirmed = await entry.terminationPromise;
      }
      return this._finish(entry, entry.terminationConfirmed
        ? { status: 'cancelled', code: 'cancelled', summary: 'Install cancelled.' }
        : {
            status: 'failed', code: 'termination_failed',
            summary: 'The installer could not be confirmed stopped.',
            error: 'Process termination was not confirmed.',
          });
    }

    if (exitCode !== 0) {
      return this._finish(entry, {
        status: 'failed',
        code: 'installer_failed',
        summary: `The Ollama installer exited with code ${exitCode}.`,
      });
    }

    // The installer wrote the new PATH to the registry, but this process kept
    // its old PATH snapshot. Prepend the known Ollama install dir(s) so the
    // re-probe (and later serve/pull spawns) resolve 'ollama' without the user
    // having to open a fresh shell — mirrors scripts/setup/setup.js's post-winget
    // PATH prepend. Best-effort: only runs when platform/env are cleanly available.
    try {
      const fileExists = typeof this.fsImpl.existsSync === 'function' ? this.fsImpl.existsSync : fs.existsSync;
      const dirs = ollamaInstallDirs(this.platform, this.env).filter((dir) => fileExists(dir));
      if (dirs.length) {
        const existingPath = String(this.env.PATH || '');
        const existingDirs = new Set(existingPath.split(path.delimiter).filter(Boolean));
        const newDirs = dirs.filter((dir) => !existingDirs.has(dir));
        if (newDirs.length) {
          this.env.PATH = [...newDirs, existingPath].filter(Boolean).join(path.delimiter);
        }
      }
    } catch (_error) {
      // best-effort PATH prepend; never block the install on it
    }

    if (upgradeRequired && this.restartImpl) {
      this._emit(entry, 'restarting');
      try {
        const restart = await this.restartImpl();
        if (restart?.ok === false) {
          this._log('WARN', 'ollama_install.restart_failed', {
            requestId: entry.requestId,
            reason: boundedError(restart.reason || 'restart_failed'),
          });
        }
      } catch (error) {
        this._log('WARN', 'ollama_install.restart_failed', {
          requestId: entry.requestId,
          reason: boundedError(error?.message || error),
        });
      }
    }

    // PATH propagation lags the installer; re-probe a few times before reporting.
    const verified = await this._reprobe(entry);
    if (entry.cancelled) {
      entry.terminationConfirmed = true;
      return this._finish(entry, { status: 'cancelled', code: 'cancelled', summary: 'Install cancelled.' });
    }
    return this._finish(entry, {
      status: verified ? 'completed' : 'failed',
      code: verified ? 'installed' : 'installed_unverified',
      summary: verified
        ? 'Ollama installed successfully.'
        : 'Ollama installed, but Jenny could not verify a supported serving version. Restart Ollama and try again.',
    });
  }

  async cancelOllamaInstall({ requestId } = {}) {
    const requestedId = normalizeRequestId(requestId);
    const entry = requestedId ? this._active.get(requestedId) : this._activeOperation;
    if (!entry) {
      return {
        cancelled: false, termination_confirmed: false, request_id: requestedId,
        status: 'not_found', code: 'not_found', error_code: '',
      };
    }
    entry.cancelled = true;
    entry.abortController?.abort();
    const hadChild = Boolean(entry.child);
    if (hadChild && !entry.terminationPromise) {
      entry.terminationPromise = this._terminateEntry(entry);
    }
    const terminationConfirmed = hadChild ? await entry.terminationPromise : false;
    if (hadChild) entry.terminationConfirmed = terminationConfirmed;
    let timer = null;
    const timed = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), this.terminationTimeoutMs);
      timer.unref?.();
    });
    const settled = await Promise.race([entry.settlement, timed]);
    if (timer) clearTimeout(timer);
    if (!settled && !entry.finished) {
      this._safeCleanup(entry);
      this._finish(entry, terminationConfirmed
        ? { status: 'cancelled', code: 'cancelled', summary: 'Install cancelled.' }
        : {
            status: 'failed', code: 'termination_failed',
            summary: 'The setup operation could not be confirmed stopped.',
            error: 'Operation termination was not confirmed.',
          });
    }
    return {
      cancelled: entry.status === 'cancelled',
      termination_confirmed: entry.terminationConfirmed === true,
      request_id: entry.requestId,
      status: entry.status,
      code: entry.code,
      error_code: entry.status === 'cancelled' ? '' : SETUP_ERROR_CODES.TERMINATION_FAILED,
    };
  }

  signalActiveInstalls() {
    for (const entry of this._active.values()) {
      entry.cancelled = true;
      entry.abortController?.abort();
      try { entry.child?.kill?.(); } catch (_error) { /* emergency best effort */ }
    }
    return this._active.size;
  }

  async disposeActiveInstalls() {
    const entries = [...this._active.values()];
    await Promise.all(entries.map((entry) => this.cancelOllamaInstall({ requestId: entry.requestId })));
    return entries.length;
  }

}

module.exports = {
  OllamaInstallService,
  defaultOllamaFallbackUrl,
};
