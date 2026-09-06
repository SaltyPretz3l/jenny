'use strict';

const { EventEmitter } = require('events');
const path = require('path');

const { FileJsonStore } = require('./backend/file-json-store');

const UPDATE_STORE_DEFAULT = {
  skippedVersion: '',
  failureCount: 0,
  lastError: '',
  lastFailedAt: '',
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
  return String(value || '').trim();
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
    releaseName: String(source.releaseName || source.name || '').trim(),
    releaseDate: String(source.releaseDate || source.release_date || '').trim(),
    releaseNotesMarkdown: normalizeReleaseNotes(source.releaseNotes),
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
  constructor({
    app,
    autoUpdater,
    autoUpdaterLoader = loadAutoUpdater,
    storePath = '',
    logger = null,
    platform = process.platform,
    now = () => new Date(),
    // macOS auto-update only works for a signed + notarized app (Squirrel.Mac
    // refuses unsigned updates). Defaults off; the signed release build sets
    // JENNY_MAC_SIGNED=1 so a signed DMG/zip can self-update.
    macUpdatesSigned = /^(1|true|yes|on)$/i.test(String(process.env.JENNY_MAC_SIGNED || '').trim()),
  } = {}) {
    super();
    this.app = app || null;
    this.autoUpdater = autoUpdater || null;
    this.autoUpdaterLoader = typeof autoUpdaterLoader === 'function'
      ? autoUpdaterLoader
      : loadAutoUpdater;
    this._autoUpdaterResolutionAttempted = false;
    this.platform = String(platform || '').trim().toLowerCase();
    this.macUpdatesSigned = Boolean(macUpdatesSigned);
    this.now = typeof now === 'function' ? now : () => new Date();
    this.logger = typeof logger === 'function' ? logger : null;
    const defaultStorePath = this.app && typeof this.app.getPath === 'function'
      ? path.join(this.app.getPath('userData'), 'update-state.json')
      : '';
    this.store = new FileJsonStore(storePath || defaultStorePath, { logger: this.logger });
    this.persisted = this._normalizePersisted(this.store.read(UPDATE_STORE_DEFAULT));
    this.disabledReason = this._disabledReason({ checkUpdater: Boolean(this.autoUpdater) });
    this._availableInfo = null;
    this._checkPromise = null;
    this._downloadPromise = null;
    this._disposed = false;
    this.state = {
      status: this.disabledReason ? 'disabled' : 'idle',
      reason: this.disabledReason,
      currentVersion: this._currentVersion(),
      latestVersion: '',
      releaseName: '',
      releaseDate: '',
      releaseNotesMarkdown: '',
      downloadProgress: {
        percent: 0,
        transferred: 0,
        total: 0,
        bytesPerSecond: 0,
      },
      skippedVersion: this.persisted.skippedVersion,
      failureCount: this.persisted.failureCount,
      lastError: this.persisted.lastError,
      lastFailedAt: this.persisted.lastFailedAt,
      devInstall: this.app?.isPackaged !== true,
      autoUpdateAllowed: !this.disabledReason,
    };
  }

  getState() {
    return cloneState(this.state);
  }

  async check() {
    if (this.disabledReason || !this._resolveAutoUpdater()) {
      return this.getState();
    }
    if (this._checkPromise) {
      return this._checkPromise;
    }
    this._checkPromise = this._checkForUpdates();
    try {
      return await this._checkPromise;
    } finally {
      this._checkPromise = null;
    }
  }

  async _checkForUpdates() {
    this._setState({
      status: 'checking',
      reason: '',
      lastError: '',
      downloadProgress: normalizeProgress(),
    });
    try {
      const result = await this.autoUpdater.checkForUpdates();
      if (this._disposed) {
        return this.getState();
      }
      if (this.state.status === 'checking') {
        const info = normalizeUpdateInfo(result?.updateInfo);
        if (info.latestVersion && info.latestVersion !== this.state.currentVersion) {
          this._handleUpdateAvailable(info.raw);
        } else {
          this._setState({
            status: 'idle',
            reason: 'Jenny is up to date.',
            latestVersion: info.latestVersion || '',
            releaseName: info.releaseName || '',
            releaseDate: info.releaseDate || '',
            releaseNotesMarkdown: info.releaseNotesMarkdown || '',
          });
        }
      }
    } catch (error) {
      if (!this._disposed) {
        this._recordError(error, 'Update check failed.');
      }
    }
    return this.getState();
  }

  async download() {
    if (this.disabledReason || !this._resolveAutoUpdater()) {
      return this.getState();
    }
    if (this._downloadPromise) {
      return this._downloadPromise;
    }
    this._downloadPromise = this._downloadUpdate();
    try {
      return await this._downloadPromise;
    } finally {
      this._downloadPromise = null;
    }
  }

  async _downloadUpdate() {
    if (this.state.status === 'downloaded') {
      return this.getState();
    }
    if (!this._availableInfo) {
      this._recordError(new Error('No update is available to download.'));
      return this.getState();
    }
    const info = normalizeUpdateInfo(this._availableInfo);
    if (!info.hasSha512) {
      this._recordError(new Error('Update metadata is missing SHA512 verification data.'));
      return this.getState();
    }
    this._setState({
      status: 'downloading',
      reason: '',
      lastError: '',
      downloadProgress: normalizeProgress(),
    });
    try {
      await this.autoUpdater.downloadUpdate();
      if (this._disposed) {
        return this.getState();
      }
      if (this.state.status === 'downloading') {
        this._setState({
          status: 'downloaded',
          reason: '',
          downloadProgress: { ...this.state.downloadProgress, percent: 100 },
        });
      }
    } catch (error) {
      if (!this._disposed) {
        this._recordError(error, 'Update download failed.');
      }
    }
    return this.getState();
  }

  async install() {
    if (this.disabledReason || !this._resolveAutoUpdater()) {
      return this.getState();
    }
    if (this.state.status === 'installing') {
      return this.getState();
    }
    if (this.state.status !== 'downloaded') {
      this._recordError(new Error('No downloaded update is ready to install.'));
      return this.getState();
    }
    this._setState({ status: 'installing', reason: '', lastError: '' });
    try {
      this.autoUpdater.quitAndInstall();
    } catch (error) {
      this._recordError(error, 'Update install handoff failed.');
    }
    return this.getState();
  }

  async skip(version = '') {
    const skippedVersion = normalizeVersion(version) || this.state.latestVersion;
    this.persisted = {
      ...this.persisted,
      skippedVersion,
    };
    this._persist();
    this._setState({
      skippedVersion,
      status: this.state.latestVersion === skippedVersion ? 'idle' : this.state.status,
      reason: skippedVersion ? `Skipped update ${skippedVersion}.` : '',
    });
    return this.getState();
  }

  dispose() {
    this._disposed = true;
    if (!this.autoUpdater || typeof this.autoUpdater.removeListener !== 'function') {
      return;
    }
    for (const [eventName, listener] of this._listeners || []) {
      this.autoUpdater.removeListener(eventName, listener);
    }
    this._listeners = [];
  }

  _currentVersion() {
    if (this.app && typeof this.app.getVersion === 'function') {
      return normalizeVersion(this.app.getVersion());
    }
    return '';
  }

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
      } else {
        return 'Automatic updates are currently enabled only for Windows and macOS packaged builds.';
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
    if (this._disposed) {
      return false;
    }
    if (this._autoUpdaterResolutionAttempted) {
      return !this.disabledReason;
    }
    this._autoUpdaterResolutionAttempted = true;
    if (!this.autoUpdater) {
      try {
        this.autoUpdater = this.autoUpdaterLoader() || null;
      } catch (error) {
        this._log('WARN', 'updates.loader_failed', {
          message: String(error && error.message || error),
        });
      }
    }
    this.disabledReason = this._disabledReason();
    if (this.disabledReason) {
      this._setState({
        status: 'disabled',
        reason: this.disabledReason,
        autoUpdateAllowed: false,
      });
      return false;
    }
    this._configureUpdater();
    this._bindUpdaterEvents();
    return true;
  }

  _configureUpdater() {
    try {
      this.autoUpdater.autoDownload = false;
      this.autoUpdater.autoInstallOnAppQuit = false;
      if ('allowPrerelease' in this.autoUpdater) {
        this.autoUpdater.allowPrerelease = false;
      }
    } catch (error) {
      this._log('WARN', 'updates.configure_failed', {
        message: String(error && error.message || error),
      });
    }
  }

  _bindUpdaterEvents() {
    this._listeners = [
      ['checking-for-update', () => {
        this._setState({ status: 'checking', reason: '', lastError: '' });
      }],
      ['update-available', (info) => this._handleUpdateAvailable(info)],
      ['update-not-available', (info) => {
        const normalized = normalizeUpdateInfo(info);
        this._availableInfo = null;
        this._setState({
          status: 'idle',
          reason: 'Jenny is up to date.',
          latestVersion: normalized.latestVersion || '',
          releaseName: normalized.releaseName || '',
          releaseDate: normalized.releaseDate || '',
          releaseNotesMarkdown: normalized.releaseNotesMarkdown || '',
        });
      }],
      ['download-progress', (progress) => {
        this._setState({
          status: 'downloading',
          reason: '',
          downloadProgress: normalizeProgress(progress),
        });
      }],
      ['update-downloaded', (info) => {
        const normalized = normalizeUpdateInfo(info || this._availableInfo);
        this._setState({
          status: 'downloaded',
          reason: '',
          latestVersion: normalized.latestVersion || this.state.latestVersion,
          releaseName: normalized.releaseName || this.state.releaseName,
          releaseDate: normalized.releaseDate || this.state.releaseDate,
          releaseNotesMarkdown: normalized.releaseNotesMarkdown || this.state.releaseNotesMarkdown,
          downloadProgress: { ...this.state.downloadProgress, percent: 100 },
        });
      }],
      ['error', (error) => this._recordError(error)],
    ];
    for (const [eventName, listener] of this._listeners) {
      this.autoUpdater.on(eventName, listener);
    }
  }

  _handleUpdateAvailable(info) {
    const normalized = normalizeUpdateInfo(info);
    if (!normalized.latestVersion) {
      this._recordError(new Error('Update metadata did not include a version.'));
      return;
    }
    if (!normalized.hasSha512) {
      this._recordError(new Error('Update metadata is missing SHA512 verification data.'));
      return;
    }
    this._availableInfo = normalized.raw;
    if (normalized.latestVersion === this.state.skippedVersion) {
      this._setState({
        status: 'idle',
        reason: `Update ${normalized.latestVersion} is skipped.`,
        latestVersion: normalized.latestVersion,
        releaseName: normalized.releaseName,
        releaseDate: normalized.releaseDate,
        releaseNotesMarkdown: normalized.releaseNotesMarkdown,
      });
      return;
    }
    this._setState({
      status: 'available',
      reason: '',
      latestVersion: normalized.latestVersion,
      releaseName: normalized.releaseName,
      releaseDate: normalized.releaseDate,
      releaseNotesMarkdown: normalized.releaseNotesMarkdown,
      downloadProgress: normalizeProgress(),
    });
  }

  _recordError(error, fallbackMessage = 'Updater failed.') {
    const message = String(error && error.message || error || fallbackMessage).trim() || fallbackMessage;
    this.persisted = {
      ...this.persisted,
      failureCount: this.persisted.failureCount + 1,
      lastError: message,
      lastFailedAt: this.now().toISOString(),
    };
    this._persist();
    this._setState({
      status: 'error',
      reason: message,
      lastError: message,
      lastFailedAt: this.persisted.lastFailedAt,
      failureCount: this.persisted.failureCount,
    });
    this._log('ERROR', 'updates.failed', { message });
  }

  _setState(patch = {}) {
    if (this._disposed) {
      return;
    }
    this.state = {
      ...this.state,
      ...(patch && typeof patch === 'object' ? patch : {}),
    };
    const state = this.getState();
    this.emit('changed', state);
    this._log('INFO', 'updates.state_changed', {
      status: state.status,
      latestVersion: state.latestVersion,
      currentVersion: state.currentVersion,
    });
  }

  _normalizePersisted(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
      skippedVersion: normalizeVersion(source.skippedVersion),
      failureCount: Math.max(Number(source.failureCount) || 0, 0),
      lastError: String(source.lastError || '').trim(),
      lastFailedAt: String(source.lastFailedAt || '').trim(),
    };
  }

  _persist() {
    this.store.write(this.persisted);
  }

  _log(level, event, details = {}) {
    if (!this.logger) {
      return;
    }
    try {
      this.logger(level, event, details);
    } catch (_error) {
      // Logging must never block updater state transitions.
    }
  }
}

module.exports = {
  UpdateService,
  normalizeProgress,
  normalizeReleaseNotes,
  normalizeUpdateInfo,
};
