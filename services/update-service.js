'use strict';

const { EventEmitter } = require('events');
const path = require('path');
const semver = require('semver');
const { t } = require('./i18n-main');
const { UPDATER_ERROR_CODES } = require('./backend/error-codes');
const { createGitHubReleaseClient, RELEASES_URL, stableVersion, MAX_NOTES_LENGTH } = require('./github-release-client');

const { FileJsonStore } = require('./backend/file-json-store');
const { resolveLinuxPackageKind } = require('./linux-package-kind');

const UPDATE_STORE_DEFAULT = {
  skippedVersion: '',
  failureCount: 0,
  lastError: '',
  lastFailedAt: '',
  lastCheckedAt: '',
};

function loadAutoUpdater() {
  try {
    return require('electron-updater').autoUpdater || null;
  } catch (_error) {
    return null;
  }
}

function cloneState(state) {
  return {
    ...state,
    downloadProgress: { ...(state.downloadProgress || {}) },
  };
}

function normalizeVersion(value) {
  return String(value || '').trim().slice(0, 128);
}

function normalizeReleaseNotes(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }
        if (entry && typeof entry === 'object') {
          return String(entry.note || entry.notes || entry.content || '').trim();
        }
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  return String(value || '').trim();
}

function normalizeUpdateInfo(info = {}) {
  const source = info && typeof info === 'object' ? info : {};
  return {
    latestVersion: normalizeVersion(source.version),
    releaseName: String(source.releaseName || source.name || '').trim().slice(0, 256),
    releaseDate: String(source.releaseDate || source.release_date || '').trim().slice(0, 64),
    releaseNotesMarkdown: normalizeReleaseNotes(source.releaseNotes).slice(0, MAX_NOTES_LENGTH),
    hasSha512: Boolean(
      String(source.sha512 || '').trim()
      || (Array.isArray(source.files)
        && source.files.some((file) => file && String(file.sha512 || '').trim()))
    ),
    raw: source,
  };
}

function normalizeProgress(progress = {}) {
  const source = progress && typeof progress === 'object' ? progress : {};
  const percent = Number(source.percent);
  const normalizedPercent = Number.isFinite(percent)
    ? Math.max(0, Math.min(100, percent))
    : 0;
  return {
    percent: normalizedPercent,
    transferred: Math.max(Number(source.transferred) || 0, 0),
    total: Math.max(Number(source.total) || 0, 0),
    bytesPerSecond: Math.max(Number(source.bytesPerSecond) || 0, 0),
  };
}

class UpdateService extends EventEmitter {
  constructor({ app, autoUpdater, autoUpdaterLoader = loadAutoUpdater,
    storePath = '', logger = null, platform = process.platform, arch = process.arch,
    env = process.env, execPath = process.execPath, now = () => new Date(),
    releaseClient = createGitHubReleaseClient(),
    macUpdatesSigned = /^(1|true|yes|on)$/i.test(String(process.env.JENNY_MAC_SIGNED || '').trim()),
  } = {}) {
    super();
    this.app = app || null;
    this.autoUpdater = autoUpdater || null;
    this.autoUpdaterLoader = autoUpdaterLoader;
    this._autoUpdaterResolutionAttempted = false;
    this.platform = String(platform || '').toLowerCase();
    this.arch = arch;
    this.env = env || {};
    this.execPath = execPath;
    this.macUpdatesSigned = Boolean(macUpdatesSigned);
    this.now = now;
    this.logger = typeof logger === 'function' ? logger : null;
    this.releaseClient = releaseClient;
    this.store = new FileJsonStore(storePath || (app?.getPath
      ? path.join(app.getPath('userData'), 'update-state.json') : ''), { logger: this.logger });
    this.persisted = this._normalizePersisted(this.store.read(UPDATE_STORE_DEFAULT));
    this.disabledReason = this._disabledReason({ checkUpdater: Boolean(autoUpdater) });
    this._availableInfo = null;
    this._downloadedVersion = '';
    this._operation = null;
    this._installOperation = null;
    this._disposed = false;
    this._abort = new AbortController();
    this.state = {
      status: 'unchecked', reason: '', currentVersion: this._currentVersion(),
      latestVersion: '', releaseName: '', releaseDate: '', releaseNotesMarkdown: '',
      releaseUrl: RELEASES_URL, packageAvailable: false,
      downloadProgress: normalizeProgress(), skippedVersion: this.persisted.skippedVersion,
      failureCount: this.persisted.failureCount, lastError: '', errorCode: '', errorStage: '',
      lastFailedAt: this.persisted.lastFailedAt, lastCheckedAt: this.persisted.lastCheckedAt,
      devInstall: app?.isPackaged !== true, autoUpdateAllowed: !this.disabledReason,
    };
  }

  getState() {
    const busy = Boolean(this._operation) || this.state.status === 'installing';
    return cloneState({ ...this.state,
      canCheck: !this._disposed && !busy && !this._downloadedVersion,
      canDownload: !this._disposed && !busy && !this.disabledReason && Boolean(this._availableInfo)
        && (this.state.status === 'available' || (this.state.status === 'error' && this.state.errorStage === 'download')),
      canInstall: !this._disposed && !busy && !this.disabledReason && Boolean(this._downloadedVersion)
        && (this.state.status === 'downloaded' || (this.state.status === 'error' && this.state.errorStage === 'install')),
      installUnavailableReason: this.disabledReason,
    });
  }

  check() {
    if (this._disposed || this._downloadedVersion || ['downloading', 'downloaded', 'installing'].includes(this.state.status)) {
      return Promise.resolve(this.getState());
    }
    return this._run('check', () => this._checkForUpdates());
  }

  download() {
    if (this._disposed || this.disabledReason || this._downloadedVersion
      || this.state.status === 'installing') return Promise.resolve(this.getState());
    return this._run('download', () => this._downloadUpdate());
  }

  install() {
    if (this._disposed || this.disabledReason || this.state.status === 'installing') {
      return Promise.resolve(this.getState());
    }
    return this._run('install', () => {
      if (!this._downloadedVersion || this._downloadedVersion !== this.state.latestVersion) {
        throw Object.assign(new Error('install-not-ready'), { code: 'install-not-ready' });
      }
      this._installOperation = this._operation;
      this._setState({ status: 'installing' });
      this.autoUpdater.quitAndInstall();
    });
  }

  _run(stage, action) {
    if (this._operation) return this._operation.stage === stage
      ? this._operation.promise : Promise.resolve(this.getState());
    // Publish the operation before executing code that may synchronously emit events.
    const operation = { stage, failed: false, promise: null };
    this._operation = operation;
    operation.promise = Promise.resolve().then(() => {
      if (this._disposed) return;
      this._setState({ reason: '', lastError: '', errorCode: '', errorStage: '' });
      return action();
    }).catch((error) => this._recordError(error, operation)).finally(() => {
      if (this._operation === operation) this._operation = null;
      if (!this._disposed) this._setState({});
    }).then(() => this.getState());
    return operation.promise;
  }

  async _checkForUpdates() {
    this._availableInfo = null;
    this._setState({ status: 'checking', downloadProgress: normalizeProgress() });
    if (this.disabledReason || !this._resolveAutoUpdater()) {
      await this._checkManualRelease();
    } else {
      try {
        const result = await this.autoUpdater.checkForUpdates();
        if (this._disposed) return;
        if (this._operation.eventError) throw this._operation.eventError;
        // The completed check owns the selected version; stale events cannot replace it.
        this._acceptUpdateInfo(result?.updateInfo, result?.isUpdateAvailable !== false);
      } catch (error) {
        if (error?.code !== 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') throw error;
        await this._checkManualRelease();
      }
    }
    if (this._disposed || this._operation.failed) return;
    this.persisted.lastCheckedAt = this.now().toISOString();
    this._persist();
    this._setState({ lastCheckedAt: this.persisted.lastCheckedAt });
  }

  async _checkManualRelease() {
    const release = await this.releaseClient({ platform: this.platform, arch: this.arch, signal: this._abort.signal });
    if (this._disposed) return;
    if (!release) {
      this._setState({ status: 'no-release', latestVersion: '', packageAvailable: false,
        releaseName: '', releaseNotesMarkdown: '', releaseDate: '' });
      return;
    }
    const comparison = this._compareVersion(release.latestVersion);
    this._setState({ ...release, status: !release.packageAvailable ? 'no-package'
      : comparison > 0 ? 'manual' : comparison < 0 ? 'ahead' : 'current' });
  }

  _compareVersion(version) {
    if (!stableVersion(version) || !semver.valid(this.state.currentVersion)) {
      throw Object.assign(new Error('invalid-version'), { code: 'invalid-version' });
    }
    return semver.compare(version, this.state.currentVersion);
  }

  _acceptUpdateInfo(raw, eligible = true) {
    const info = normalizeUpdateInfo(raw);
    const comparison = this._compareVersion(info.latestVersion);
    if (raw?.tag && stableVersion(raw.tag) !== info.latestVersion) {
      throw Object.assign(new Error('invalid-version'), { code: 'invalid-version' });
    }
    if (!info.hasSha512) throw Object.assign(new Error('missing-sha512'), { code: 'missing-sha512' });
    if (comparison > 0 && eligible) this._availableInfo = info.raw;
    const { raw: _raw, hasSha512: _hasSha512, ...display } = info;
    this._setState({ ...display, packageAvailable: true,
      status: comparison > 0 ? (eligible ? 'available' : 'manual') : comparison < 0 ? 'ahead' : 'current' });
  }

  async _downloadUpdate() {
    if (!this._availableInfo) throw Object.assign(new Error('download-not-ready'), { code: 'download-not-ready' });
    const version = normalizeVersion(this._availableInfo.version);
    this._setState({ status: 'downloading', downloadProgress: normalizeProgress() });
    const files = await this.autoUpdater.downloadUpdate();
    if (this._disposed || this._operation.failed) return;
    if (this._operation.eventError) throw this._operation.eventError;
    if (!Array.isArray(files) || !files.length) throw new Error('download-incomplete');
    this._downloadedVersion = version;
    this._setState({ status: 'downloaded', latestVersion: version,
      downloadProgress: { ...this.state.downloadProgress, percent: 100 } });
  }

  async skip(version = '') {
    // Compatibility only: explicit checks always reveal a release, even if skipped.
    if (this._disposed) return this.getState();
    const skippedVersion = normalizeVersion(version) || this.state.latestVersion;
    this.persisted.skippedVersion = skippedVersion;
    this._persist();
    this._setState({ skippedVersion });
    return this.getState();
  }

  dispose() {
    this._disposed = true;
    this._abort.abort();
    for (const [event, listener] of this._listeners || []) this.autoUpdater.removeListener(event, listener);
    this._listeners = [];
  }

  _currentVersion() { return normalizeVersion(this.app?.getVersion?.()); }

  _disabledReason({ checkUpdater = true } = {}) {
    if (!this.app || this.app.isPackaged !== true) {
      return 'Automatic updates are disabled until Jenny is running from a packaged install.';
    }
    if (this.platform && this.platform !== 'win32') {
      if (this.platform === 'darwin') {
        if (!this.macUpdatesSigned) {
          return 'Automatic updates on macOS require a signed build; download the latest DMG from the releases page.';
        }
        // Signed mac build: fall through to the electron-updater availability check.
      } else if (this.platform === 'linux') {
        if (resolveLinuxPackageKind({
          platform: this.platform,
          env: this.env,
          execPath: this.execPath,
        }) !== 'appimage') {
          return 'Automatic updates are unavailable for this Linux package; download the latest .deb or AppImage from the releases page.';
        }
        // AppImage build: fall through to the electron-updater availability check.
      } else {
        return 'Automatic updates are currently enabled only for Windows, macOS, and Linux AppImage packaged builds.';
      }
    }
    if (checkUpdater && (
      !this.autoUpdater
      || typeof this.autoUpdater.checkForUpdates !== 'function'
      || typeof this.autoUpdater.downloadUpdate !== 'function'
      || typeof this.autoUpdater.quitAndInstall !== 'function'
    )) {
      return 'Automatic updates are unavailable because electron-updater is not loaded.';
    }
    return '';
  }

  _resolveAutoUpdater() {
    if (this._disposed) return false;
    if (this._autoUpdaterResolutionAttempted) return !this.disabledReason;
    this._autoUpdaterResolutionAttempted = true;
    try {
      this.autoUpdater = this.autoUpdater || this.autoUpdaterLoader();
      this.disabledReason = this._disabledReason();
      if (!this.disabledReason) {
        this.autoUpdater.autoDownload = false;
        this.autoUpdater.autoInstallOnAppQuit = false;
        this.autoUpdater.allowPrerelease = false;
        this.autoUpdater.allowDowngrade = false;
        this.autoUpdater.requestHeaders = { 'x-user-staging-id': 'manual' };
        // Never pipe provider response bodies, paths or identifiers into diagnostics.
        this.autoUpdater.logger = { info() {}, warn() {}, error() {}, debug() {} };
        if (this.autoUpdater.autoDownload !== false || this.autoUpdater.autoInstallOnAppQuit !== false) {
          throw new Error('unsafe-updater-configuration');
        }
        this._bindUpdaterEvents();
      }
    } catch (_error) {
      this.disabledReason = t('updates.service.unavailable', 'Self-installation is unavailable in this build.');
      this._log('WARN', 'updates.loader_failed', {});
    }
    this._setState({ autoUpdateAllowed: !this.disabledReason });
    return !this.disabledReason;
  }

  _bindUpdaterEvents() {
    this._listeners = [
      ['download-progress', (progress) => {
        if (this._operation?.stage !== 'download' || this._operation.failed) return;
        this._setState({ status: 'downloading', downloadProgress: normalizeProgress(progress) });
      }],
      ['update-available', () => {}],
      ['error', (error) => {
        const operation = this._operation || this._installOperation;
        if (operation?.stage === 'install') this._recordError(error, operation);
        else if (operation) operation.eventError = error;
      }],
    ];
    for (const [event, listener] of this._listeners) this.autoUpdater.on(event, listener);
  }

  _recordError(error, operation) {
    if (this._disposed || !operation || operation.failed) return;
    operation.failed = true;
    const stage = operation.stage;
    let message = t('updates.service.checkFailed', 'Could not check GitHub. Check your connection and try again.');
    if (stage === 'download') message = t('updates.service.downloadFailed', 'Could not download and verify the update. Try the download again.');
    if (stage === 'install') message = t('updates.service.installFailed', 'Could not hand off the installer. Try again or open the releases page.');
    if (error?.code === 'rate-limited') message = t('updates.service.rateLimited', 'GitHub is limiting requests. Try again later.');
    if (error?.code === 'timeout') message = t('updates.service.timeout', 'GitHub did not respond in time. Try again.');
    if (error?.code === 'invalid-version') message = t('updates.service.invalidVersion', 'The release version is invalid. Open the releases page.');
    if (error?.code === 'missing-sha512') message = t('updates.service.missingHash', 'Release metadata is missing SHA512 verification data. Open the releases page.');
    const errorCode = UPDATER_ERROR_CODES[stage];
    this.persisted = { ...this.persisted, failureCount: Math.min(this.persisted.failureCount + 1, 1000000),
      lastError: message, lastFailedAt: this.now().toISOString() };
    this._persist();
    this._setState({ status: 'error', reason: message, lastError: message, errorCode, errorStage: stage,
      failureCount: this.persisted.failureCount, lastFailedAt: this.persisted.lastFailedAt });
    this._log('ERROR', 'updates.failed', { errorCode, stage });
  }

  _setState(patch) {
    if (this._disposed) return;
    const previousStatus = this.state.status;
    this.state = { ...this.state, ...patch };
    if (this.state.status !== previousStatus) this._log('INFO', 'updates.state_changed', {
      status: this.state.status, currentVersion: this.state.currentVersion, latestVersion: this.state.latestVersion,
    });
    this.emit('changed', this.getState());
  }

  _normalizePersisted(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return { ...source, skippedVersion: normalizeVersion(source.skippedVersion),
      failureCount: Math.max(0, Math.min(Math.trunc(Number(source.failureCount)) || 0, 1000000)),
      lastError: '',
      lastFailedAt: Number.isFinite(Date.parse(source.lastFailedAt)) ? new Date(source.lastFailedAt).toISOString() : '',
      lastCheckedAt: Number.isFinite(Date.parse(source.lastCheckedAt)) ? new Date(source.lastCheckedAt).toISOString() : '' };
  }

  _persist() { this.store.write(this.persisted); }

  _log(level, event, details) {
    try { this.logger?.(level, event, details); } catch (_error) { /* diagnostics never block updates */ }
  }
}

module.exports = { UpdateService, normalizeProgress, normalizeReleaseNotes, normalizeUpdateInfo };
