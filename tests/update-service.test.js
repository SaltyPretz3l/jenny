'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { UpdateService } = require('../services/update-service');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

// getPath('userData') below is called on every fixture, so an untracked
// mkdtempSync here left 25 directories in the user's TEMP per run (measured
// with TMPDIR redirected at an empty directory).
function makeTempDir() {
  return createTrackedTempDir('jenny-update-service-');
}

function makeApp({ version = '0.1.0', isPackaged = true } = {}) {
  return {
    isPackaged,
    getVersion: () => version,
    getPath(name) {
      assert.equal(name, 'userData');
      return makeTempDir();
    },
  };
}

class FakeAutoUpdater extends EventEmitter {
  constructor(updateInfo = {}) {
    super();
    this.updateInfo = {
      version: '0.2.0',
      releaseName: 'Jenny 0.2.0',
      releaseNotes: '## Fixes\n\n- Safer updater path',
      files: [{ url: 'Jenny-0.2.0.exe', sha512: 'abc123' }],
      ...updateInfo,
    };
    this.calls = [];
    this.autoDownload = true;
  }

  checkForUpdates() {
    this.calls.push('checkForUpdates');
    this.emit('checking-for-update');
    this.emit('update-available', this.updateInfo);
    return Promise.resolve({ updateInfo: this.updateInfo });
  }

  downloadUpdate() {
    this.calls.push('downloadUpdate');
    this.emit('download-progress', {
      percent: 42,
      transferred: 420,
      total: 1000,
      bytesPerSecond: 250,
    });
    this.emit('update-downloaded', this.updateInfo);
    return Promise.resolve(['Jenny-0.2.0.exe']);
  }

  quitAndInstall() {
    this.calls.push('quitAndInstall');
  }
}

class DeferredAutoUpdater extends FakeAutoUpdater {
  constructor(updateInfo = {}) {
    super(updateInfo);
    this._resolveCheck = null;
    this._resolveDownload = null;
  }

  checkForUpdates() {
    this.calls.push('checkForUpdates');
    this.emit('checking-for-update');
    return new Promise((resolve) => {
      this._resolveCheck = () => {
        this.emit('update-available', this.updateInfo);
        resolve({ updateInfo: this.updateInfo });
      };
    });
  }

  downloadUpdate() {
    this.calls.push('downloadUpdate');
    this.emit('download-progress', {
      percent: 42,
      transferred: 420,
      total: 1000,
      bytesPerSecond: 250,
    });
    return new Promise((resolve) => {
      this._resolveDownload = () => {
        this.emit('update-downloaded', this.updateInfo);
        resolve(['Jenny-0.2.0.exe']);
      };
    });
  }

  resolveCheck() {
    assert.equal(typeof this._resolveCheck, 'function');
    this._resolveCheck();
  }

  resolveDownload() {
    assert.equal(typeof this._resolveDownload, 'function');
    this._resolveDownload();
  }
}

test('UpdateService discovers releases in development but cannot self-install', async () => {
  const updater = new FakeAutoUpdater();
  const service = new UpdateService({
    app: makeApp({ isPackaged: false }),
    autoUpdater: updater,
    releaseClient: async () => ({ latestVersion: '0.2.0', packageAvailable: true }),
    storePath: path.join(makeTempDir(), 'updates.json'),
  });

  assert.equal(service.getState().status, 'unchecked');
  assert.match(service.getState().installUnavailableReason, /packaged/i);

  const checked = await service.check();
  const downloaded = await service.download();

  assert.equal(checked.status, 'manual');
  assert.equal(checked.canDownload, false);
  assert.equal(downloaded.status, 'manual');
  assert.deepEqual(updater.calls, []);
});

test('UpdateService disables auto-update on an unsigned macOS build with a manual-DMG hint', () => {
  const service = new UpdateService({
    app: makeApp({ isPackaged: true }),
    autoUpdater: new FakeAutoUpdater(),
    storePath: path.join(makeTempDir(), 'updates.json'),
    platform: 'darwin',
    macUpdatesSigned: false,
  });
  assert.equal(service.getState().status, 'unchecked');
  assert.match(service.getState().installUnavailableReason, /signed build/i);
  assert.match(service.getState().installUnavailableReason, /DMG/i);
});

test('UpdateService enables auto-update on a signed macOS build', () => {
  const service = new UpdateService({
    app: makeApp({ isPackaged: true }),
    autoUpdater: new FakeAutoUpdater(),
    storePath: path.join(makeTempDir(), 'updates.json'),
    platform: 'darwin',
    macUpdatesSigned: true,
  });
  assert.equal(service.getState().status, 'unchecked');
  assert.equal(service.getState().reason, '');
  assert.equal(service.getState().autoUpdateAllowed, true);
});

test('UpdateService disables auto-update for Linux packages without APPIMAGE', () => {
  const service = new UpdateService({
    app: makeApp({ isPackaged: true }),
    autoUpdater: new FakeAutoUpdater(),
    storePath: path.join(makeTempDir(), 'updates.json'),
    platform: 'linux',
    env: {},
  });
  assert.equal(service.getState().status, 'unchecked');
  assert.match(service.getState().installUnavailableReason, /download the latest/i);
});

test('UpdateService enables auto-update for a Linux AppImage', () => {
  const service = new UpdateService({
    app: makeApp({ isPackaged: true }),
    autoUpdater: new FakeAutoUpdater(),
    storePath: path.join(makeTempDir(), 'updates.json'),
    platform: 'linux',
    env: {
      APPIMAGE: '/home/u/Jenny-x86_64.AppImage',
      APPDIR: '/tmp/.mount_Jenny',
    },
    execPath: '/tmp/.mount_Jenny/usr/bin/jenny',
  });
  assert.equal(service.getState().status, 'unchecked');
  assert.equal(service.getState().reason, '');
  assert.equal(service.getState().autoUpdateAllowed, true);
});

test('UpdateService ignores inherited AppImage variables on Linux', () => {
  const service = new UpdateService({
    app: makeApp({ isPackaged: true }),
    autoUpdater: new FakeAutoUpdater(),
    storePath: path.join(makeTempDir(), 'updates.json'),
    platform: 'linux',
    env: { APPIMAGE: '/tools/Other.AppImage', APPDIR: '/tmp/.mount_Other' },
    execPath: '/opt/Jenny/jenny',
  });
  assert.equal(service.getState().status, 'unchecked');
  assert.match(service.getState().installUnavailableReason, /unavailable for this Linux package/i);
});

test('UpdateService keeps auto-update disabled on unknown platforms', () => {
  const service = new UpdateService({
    app: makeApp({ isPackaged: true }),
    autoUpdater: new FakeAutoUpdater(),
    storePath: path.join(makeTempDir(), 'updates.json'),
    platform: 'freebsd',
  });
  assert.equal(service.getState().status, 'unchecked');
});

test('UpdateService exposes available, download, install, and changed states', async () => {
  const updater = new FakeAutoUpdater();
  const changes = [];
  const service = new UpdateService({
    app: makeApp({ version: '0.1.0' }),
    autoUpdater: updater,
    storePath: path.join(makeTempDir(), 'updates.json'),
  });
  service.on('changed', (state) => changes.push(state));

  const available = await service.check();
  assert.equal(updater.autoDownload, false);
  assert.equal(available.status, 'available');
  assert.equal(available.currentVersion, '0.1.0');
  assert.equal(available.latestVersion, '0.2.0');
  assert.match(available.releaseNotesMarkdown, /Safer updater path/);

  const downloaded = await service.download();
  assert.equal(downloaded.status, 'downloaded');
  assert.equal(downloaded.downloadProgress.percent, 100);

  const installing = await service.install();
  assert.equal(installing.status, 'installing');
  assert.deepEqual(updater.calls, ['checkForUpdates', 'downloadUpdate', 'quitAndInstall']);
  assert.ok(changes.some((state) => state.status === 'checking'));
  assert.ok(changes.some((state) => state.status === 'downloaded'));
});

test('UpdateService coalesces overlapping check and download requests', async () => {
  const updater = new DeferredAutoUpdater();
  const service = new UpdateService({
    app: makeApp({ version: '0.1.0' }),
    autoUpdater: updater,
    storePath: path.join(makeTempDir(), 'updates.json'),
  });

  const firstCheck = service.check();
  const secondCheck = service.check();
  await Promise.resolve();
  assert.deepEqual(updater.calls, ['checkForUpdates']);
  updater.resolveCheck();
  const [firstAvailable, secondAvailable] = await Promise.all([firstCheck, secondCheck]);
  assert.equal(firstAvailable.status, 'available');
  assert.equal(secondAvailable.status, 'available');

  const firstDownload = service.download();
  const secondDownload = service.download();
  await Promise.resolve();
  assert.deepEqual(updater.calls, ['checkForUpdates', 'downloadUpdate']);
  updater.resolveDownload();
  const [firstDownloaded, secondDownloaded] = await Promise.all([firstDownload, secondDownload]);
  assert.equal(firstDownloaded.status, 'downloaded');
  assert.equal(secondDownloaded.status, 'downloaded');
});

test('UpdateService ignores check and download settlements after disposal', async () => {
  let resolveCheck;
  const checkUpdater = new FakeAutoUpdater();
  checkUpdater.checkForUpdates = () => new Promise((resolve) => { resolveCheck = resolve; });
  const checkService = new UpdateService({
    app: makeApp({ version: '0.1.0' }),
    autoUpdater: checkUpdater,
    storePath: path.join(makeTempDir(), 'check-updates.json'),
  });

  const pendingCheck = checkService.check();
  await Promise.resolve();
  checkService.dispose();
  resolveCheck({ updateInfo: checkUpdater.updateInfo });
  const checkState = await pendingCheck;
  assert.equal(checkState.status, 'checking');
  assert.equal(checkService._availableInfo, null);

  let rejectDownload;
  const downloadStorePath = path.join(makeTempDir(), 'download-updates.json');
  const downloadUpdater = new FakeAutoUpdater();
  downloadUpdater.downloadUpdate = () => new Promise((_resolve, reject) => { rejectDownload = reject; });
  const downloadService = new UpdateService({
    app: makeApp({ version: '0.1.0' }),
    autoUpdater: downloadUpdater,
    storePath: downloadStorePath,
  });
  await downloadService.check();
  const pendingDownload = downloadService.download();
  await Promise.resolve();
  downloadService.dispose();
  rejectDownload(new Error('late download failure'));
  const downloadState = await pendingDownload;
  assert.equal(downloadState.failureCount, 0);
  assert.equal(JSON.parse(fs.readFileSync(downloadStorePath, 'utf8')).failureCount, 0);
});

test('UpdateService persists skipped versions without calling the updater', async () => {
  const storePath = path.join(makeTempDir(), 'updates.json');
  const updater = new FakeAutoUpdater();
  const service = new UpdateService({
    app: makeApp({ version: '0.1.0' }),
    autoUpdater: updater,
    storePath,
  });

  await service.skip('0.2.0');
  assert.equal(service.getState().skippedVersion, '0.2.0');

  const restored = new UpdateService({
    app: makeApp({ version: '0.1.0' }),
    autoUpdater: new FakeAutoUpdater(),
    storePath,
  });
  assert.equal(restored.getState().skippedVersion, '0.2.0');
});

test('UpdateService rejects an update payload missing a version', async () => {
  const updater = new FakeAutoUpdater({ version: '', files: [{ url: 'x', sha512: 'abc' }] });
  const service = new UpdateService({
    app: makeApp({ version: '0.1.0' }),
    autoUpdater: updater,
    storePath: path.join(makeTempDir(), 'updates.json'),
  });

  const result = await service.check();

  assert.equal(result.status, 'error');
  assert.match(result.lastError, /version/i);
  assert.equal(service.getState().failureCount, 1);
});

test('UpdateService rejects an update payload missing SHA512 verification data', async () => {
  const updater = new FakeAutoUpdater({ files: [{ url: 'Jenny-0.2.0.exe' }] });
  const service = new UpdateService({
    app: makeApp({ version: '0.1.0' }),
    autoUpdater: updater,
    storePath: path.join(makeTempDir(), 'updates.json'),
  });

  const result = await service.check();

  assert.equal(result.status, 'error');
  assert.match(result.lastError, /SHA512/i);
  assert.equal(service.getState().failureCount, 1);
});

test('UpdateService treats install while installing as a no-op', async () => {
  const updater = new FakeAutoUpdater();
  const service = new UpdateService({
    app: makeApp({ version: '0.1.0' }),
    autoUpdater: updater,
    storePath: path.join(makeTempDir(), 'updates.json'),
  });

  await service.check();
  await service.download();
  await service.install();
  const installCalls = updater.calls.filter((name) => name === 'quitAndInstall').length;
  assert.equal(installCalls, 1);
  assert.equal(service.getState().status, 'installing');

  const second = await service.install();
  const totalInstallCalls = updater.calls.filter((name) => name === 'quitAndInstall').length;
  assert.equal(totalInstallCalls, 1);
  assert.equal(second.status, 'installing');
  assert.equal(service.getState().lastError, '');
});

test('UpdateService keeps getState cache-only and resolves the updater on first check', async () => {
  const updater = new FakeAutoUpdater();
  let loaderCalls = 0;
  const service = new UpdateService({
    app: makeApp({ version: '0.1.0' }),
    autoUpdaterLoader: () => {
      loaderCalls += 1;
      return updater;
    },
    storePath: path.join(makeTempDir(), 'updates.json'),
  });

  assert.equal(service.getState().status, 'unchecked');
  assert.equal(loaderCalls, 0);
  assert.equal(updater.autoDownload, true);

  await service.check();
  assert.equal(loaderCalls, 1);
  assert.equal(updater.autoDownload, false);
  assert.deepEqual(updater.calls, ['checkForUpdates']);
  assert.equal(updater.listenerCount('update-available'), 1);

  await service.check();
  assert.equal(loaderCalls, 1);
  assert.equal(updater.listenerCount('update-available'), 1);
});

test('UpdateService caches updater loader failure', async () => {
  let loaderCalls = 0;
  const service = new UpdateService({
    app: makeApp({ version: '0.1.0' }),
    autoUpdaterLoader: () => {
      loaderCalls += 1;
      throw new Error('module load failed');
    },
    releaseClient: async () => null,
    storePath: path.join(makeTempDir(), 'updates.json'),
  });

  assert.equal(service.getState().status, 'unchecked');
  assert.equal(loaderCalls, 0);
  assert.equal((await service.check()).status, 'no-release');
  assert.equal((await service.check()).status, 'no-release');
  assert.equal(loaderCalls, 1);
  assert.match(service.getState().installUnavailableReason, /unavailable/i);
});

test('UpdateService binds no updater listeners when check() is called after dispose()', async () => {
  const updater = new FakeAutoUpdater();
  const service = new UpdateService({
    app: makeApp({ version: '0.1.0' }),
    autoUpdater: updater,
    storePath: path.join(makeTempDir(), 'updates.json'),
  });

  // dispose() may run while an 'updates.check' IPC handler is still
  // reachable during shutdown; _resolveAutoUpdater() must not treat a
  // disposed service as eligible for a fresh bind.
  service.dispose();
  await service.check();

  assert.equal(updater.eventNames().length, 0);
  assert.deepEqual(updater.calls, []);
});

test('UpdateService prefers an injected updater but still defers setup until an operation', async () => {
  const updater = new FakeAutoUpdater();
  let loaderCalls = 0;
  const service = new UpdateService({
    app: makeApp({ version: '0.1.0' }),
    autoUpdater: updater,
    autoUpdaterLoader: () => {
      loaderCalls += 1;
      return new FakeAutoUpdater();
    },
    storePath: path.join(makeTempDir(), 'updates.json'),
  });

  assert.equal(updater.autoDownload, true);
  service.getState();
  assert.equal(updater.autoDownload, true);
  await service.check();

  assert.equal(loaderCalls, 0);
  assert.equal(updater.autoDownload, false);
  assert.deepEqual(updater.calls, ['checkForUpdates']);
});
