'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { UpdateService } = require('../services/update-service');
const { createTrackedTempDir, cleanupTrackedResources } = require('./helpers/resource-cleanup');
test.afterEach(cleanupTrackedResources);

function fixture(t, overrides = {}) {
  const installerBytes = Buffer.from('verified Jenny installer');
  const downloadedFile = path.join(createTrackedTempDir('update-artifact-'), 'Jenny.exe');
  fs.writeFileSync(downloadedFile, installerBytes);
  const info = { version: '1.0.2', files: [{
    url: 'Jenny.exe',
    sha512: crypto.createHash('sha512').update(installerBytes).digest('base64'),
    size: installerBytes.length,
  }] };
  const updater = new EventEmitter();
  updater.checkForUpdates = async () => ({ updateInfo: info });
  updater.downloadUpdate = async () => {
    updater.emit('update-downloaded', { ...info, downloadedFile });
    return [downloadedFile];
  };
  updater.quitAndInstall = () => {};
  const storePath = path.join(createTrackedTempDir('update-recovery-'), 'state.json');
  const service = new UpdateService({
    app: { isPackaged: true, getVersion: () => '1.0.1' }, platform: 'win32',
    storePath, autoUpdater: updater, ...overrides,
  });
  t.after(() => service.dispose());
  return { service, updater, info, storePath, downloadedFile };
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
  const { service, updater, info, downloadedFile } = fixture(t);
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
  updater.emit('update-downloaded', { ...info, downloadedFile });
  finish([downloadedFile]);
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

test('failed downloads can retry their own stage', async (t) => {
  const { service, updater } = fixture(t);
  await service.check();
  updater.downloadUpdate = async () => { throw new Error('interrupted'); };
  assert.equal((await service.download()).canDownload, true);
});

test('install verifies matching installer bytes before launching once', async (t) => {
  const { service, updater, info, downloadedFile } = fixture(t);
  let launches = 0;
  updater.quitAndInstall = () => { launches += 1; };
  await service.check();
  await service.download();
  assert.deepEqual(service._downloadedArtifact, {
    path: downloadedFile,
    sha512: info.files[0].sha512,
    size: info.files[0].size,
    version: info.version,
  });

  const installed = await service.install();

  assert.equal(installed.status, 'installing');
  assert.equal(launches, 1);
});

test('install rejects an installer rewritten after download', async (t) => {
  const { service, updater, downloadedFile } = fixture(t);
  let launches = 0;
  updater.quitAndInstall = () => { launches += 1; };
  await service.check();
  await service.download();
  fs.writeFileSync(downloadedFile, 'replaced installer bytes');

  const failed = await service.install();

  assert.equal(failed.errorCode, 'install-integrity');
  assert.equal(failed.errorStage, 'install');
  assert.equal(failed.canInstall, false);
  assert.equal(failed.canCheck, true);
  assert.equal(launches, 0);
});

test('install rejects a size-only metadata mismatch', async (t) => {
  const { service, updater, info } = fixture(t);
  info.files[0].size += 1;
  let launches = 0;
  updater.quitAndInstall = () => { launches += 1; };
  await service.check();
  await service.download();

  const failed = await service.install();

  assert.equal(failed.errorCode, 'install-integrity');
  assert.equal(failed.canInstall, false);
  assert.equal(failed.canCheck, true);
  assert.equal(launches, 0);
});

test('install rejects a missing downloaded installer', async (t) => {
  const { service, updater, downloadedFile } = fixture(t);
  let launches = 0;
  updater.quitAndInstall = () => { launches += 1; };
  await service.check();
  await service.download();
  fs.unlinkSync(downloadedFile);

  const failed = await service.install();

  assert.equal(failed.errorCode, 'install-integrity');
  assert.equal(failed.canInstall, false);
  assert.equal(failed.canCheck, true);
  assert.equal(launches, 0);
});

test('a rejected installer launch requires restart and never calls the updater again', async (t) => {
  const { service, updater } = fixture(t);
  let launches = 0;
  updater.quitAndInstall = async () => {
    launches += 1;
    throw new Error('spawn rejected');
  };
  await service.check();
  await service.download();

  const failed = await service.install();
  const retried = await service.install();

  assert.equal(failed.errorCode, 'install-launch-failed');
  assert.equal(failed.errorStage, 'install');
  assert.equal(failed.canInstall, false);
  assert.equal(failed.installUnavailableReason, 'restart-required');
  assert.equal(retried.installUnavailableReason, 'restart-required');
  assert.equal(launches, 1);
});

test('an installer error event after launch also latches until restart', async (t) => {
  const { service, updater } = fixture(t);
  let launches = 0;
  updater.quitAndInstall = () => { launches += 1; };
  await service.check();
  await service.download();
  await service.install();

  updater.emit('error', new Error('late spawn failure'));
  const failed = service.getState();
  await service.install();

  assert.equal(failed.errorCode, 'install-launch-failed');
  assert.equal(failed.errorStage, 'install');
  assert.equal(failed.canInstall, false);
  assert.equal(failed.installUnavailableReason, 'restart-required');
  assert.equal(launches, 1);
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

test('an updater check has a total deadline and ignores its late settlement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { service, updater, info } = fixture(t);
  let resolveCheck;
  updater.checkForUpdates = () => new Promise((resolve) => {
    resolveCheck = () => {
      updater.emit('update-available', { ...info, version: '9.0.0' });
      resolve({ updateInfo: { ...info, version: '9.0.0' } });
    };
  });

  const pending = service.check();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(typeof resolveCheck, 'function');
  t.mock.timers.tick(15_000);
  const timedOut = await pending;

  assert.equal(timedOut.status, 'error');
  assert.equal(timedOut.errorCode, 'update-check-timeout');
  assert.equal(timedOut.errorStage, 'check');
  assert.equal(timedOut.canCheck, true);
  const stateAfterTimeout = service.getState();
  resolveCheck();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(service.getState(), stateAfterTimeout);
});
