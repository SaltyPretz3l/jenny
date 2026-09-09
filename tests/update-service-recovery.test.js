'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { UpdateService } = require('../services/update-service');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');
test.afterEach(cleanupTrackedResources);

function fixture(t, overrides = {}) {
  const info = { version: '1.0.2', files: [{ url: 'Jenny.exe', sha512: 'hash' }] };
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => ({ updateInfo: info });
  updater.downloadUpdate = async () => ['verified.exe'];
  updater.quitAndInstall = () => {};
  const storePath = path.join(createTrackedTempDir('update-recovery-'), 'state.json');
  const service = new UpdateService({
    app: { isPackaged: true, getVersion: () => '1.0.1' }, platform: 'win32',
    storePath, autoUpdater: updater, ...overrides,
  });
  t.after(() => service.dispose());
  return { service, updater, info, storePath };
}

test('explicit checks ignore persisted skips and historical checks are never fresh', async (t) => {
  const { service, storePath } = fixture(t);
  await service.skip('1.0.2');
  assert.equal((await service.check()).status, 'available');
  const prior = JSON.parse(fs.readFileSync(storePath));
  const restored = fixture(t, { storePath }).service;
  assert.equal(restored.getState().status, 'unchecked');
  assert.equal(restored.getState().lastCheckedAt, prior.lastCheckedAt);
  assert.equal(restored.getState().canInstall, false);
});

test('check cannot replace downloading/downloaded state or change the selected version', async (t) => {
  const { service, updater } = fixture(t);
  let checks = 0;
  const original = updater.checkForUpdates;
  updater.checkForUpdates = () => { checks += 1; return original(); };
  await service.check();
  let finish;
  updater.downloadUpdate = () => new Promise((resolve) => { finish = resolve; });
  const pending = service.download();
  await Promise.resolve();
  assert.equal((await service.check()).status, 'downloading');
  updater.emit('update-available', { version: '9.0.0' });
  finish(['verified.exe']);
  assert.equal((await pending).status, 'downloaded');
  assert.equal((await service.check()).status, 'downloaded');
  assert.equal(service.getState().latestVersion, '1.0.2');
  assert.equal(checks, 1);
});

test('one failed operation counts once and diagnostics do not expose raw paths or secrets', async (t) => {
  const { service, updater } = fixture(t);
  const error = new Error('secret=abc C:/private/profile');
  updater.checkForUpdates = async () => { updater.emit('error', error); throw error; };
  const result = await service.check();
  assert.equal(result.failureCount, 1);
  assert.equal(result.errorStage, 'check');
  assert.equal(result.errorCode, 'CMP-UPD-0001');
  assert.doesNotMatch(JSON.stringify(result), /secret=abc|private/);
});

test('failed downloads and install handoffs retry their own stage', async (t) => {
  const { service, updater } = fixture(t);
  await service.check();
  updater.downloadUpdate = async () => { throw new Error('interrupted'); };
  assert.equal((await service.download()).canDownload, true);
  updater.downloadUpdate = async () => ['verified.exe'];
  await service.download();
  updater.quitAndInstall = () => { throw new Error('refused'); };
  const failed = await service.install();
  assert.equal(failed.errorStage, 'install');
  assert.equal(failed.canInstall, true);
  updater.quitAndInstall = () => {};
  assert.equal((await service.install()).status, 'installing');
  updater.emit('error', new Error('late spawn failure'));
  assert.equal(service.getState().errorStage, 'install');
});

test('manual checks distinguish no release, no package, current and ahead', async (t) => {
  for (const [release, expected] of [
    [null, 'no-release'], [{ latestVersion: '1.0.2', packageAvailable: false }, 'no-package'],
    [{ latestVersion: '1.0.1', packageAvailable: false }, 'no-package'],
    [{ latestVersion: '1.0.0', packageAvailable: false }, 'no-package'],
    [{ latestVersion: '1.0.1', packageAvailable: true }, 'current'],
    [{ latestVersion: '1.0.0', packageAvailable: true }, 'ahead'],
  ]) {
    const { service } = fixture(t, { platform: 'darwin', releaseClient: async () => release });
    assert.equal((await service.check()).status, expected);
  }
});

test('updater configuration sends a constant staging header and never auto-installs', async (t) => {
  const { service, updater } = fixture(t);
  await service.check();
  assert.equal(updater.requestHeaders['x-user-staging-id'], 'manual');
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowPrerelease, false);
  assert.equal(updater.allowDowngrade, false);
});

test('a newer release rejected by the library cannot reuse its previous download provider', async (t) => {
  const { service, updater, info } = fixture(t);
  updater.checkForUpdates = async () => ({ updateInfo: info, isUpdateAvailable: true });
  assert.equal((await service.check()).canDownload, true);
  updater.checkForUpdates = async () => ({
    updateInfo: { ...info, version: '1.0.3', minimumSystemVersion: '999.0.0' },
    isUpdateAvailable: false,
  });
  const rejected = await service.check();
  assert.equal(rejected.status, 'manual');
  assert.equal(rejected.latestVersion, '1.0.3');
  assert.equal(rejected.canDownload, false);
  let downloads = 0;
  updater.downloadUpdate = async () => { downloads += 1; return ['old-provider.exe']; };
  await service.download();
  assert.equal(downloads, 0);
  assert.equal(service.getState().canInstall, false);
});

test('missing channel metadata falls back to manual discovery without claiming current', async (t) => {
  const { service, updater } = fixture(t, { releaseClient: async () =>
    ({ latestVersion: '1.0.2', packageAvailable: false }) });
  updater.checkForUpdates = async () => {
    const error = Object.assign(new Error('missing channel'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' });
    updater.emit('error', error); throw error;
  };
  assert.equal((await service.check()).status, 'no-package');
  assert.equal(service.getState().failureCount, 0);
});
