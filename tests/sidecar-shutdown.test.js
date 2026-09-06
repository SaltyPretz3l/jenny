const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getManagedSidecarStatePath,
  shutdownManagedSidecarSync,
} = require('../services/backend/sidecar-shutdown');
const {
  cleanupTrackedResources,
  trackDirectory,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('shutdownManagedSidecarSync force-kills a live managed sidecar and clears state', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-sidecar-shutdown-'));
  trackDirectory(userDataPath);
  const statePath = getManagedSidecarStatePath(userDataPath);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    pid: 210123,
    command: 'python -m sidecar',
  }), 'utf8');
  const spawnCalls = [];
  let alive = true;

  const result = shutdownManagedSidecarSync({
    userDataPath,
    platform: 'win32',
    spawnSyncImpl: (command, args, options) => {
      spawnCalls.push({ command, args: [...args], timeout: options.timeout });
      alive = false;
      return { status: 0 };
    },
    isProcessAliveImpl: () => alive,
    getProcessCommandLineSyncImpl: () => '"python"   -m sidecar',
  });

  assert.deepEqual(result, { hadState: true, killed: true, pid: 210123 });
  assert.deepEqual(spawnCalls, [
    { command: 'taskkill', args: ['/PID', '210123', '/T', '/F'], timeout: 2000 },
  ]);
  assert.equal(fs.existsSync(statePath), false);
});

test('shutdownManagedSidecarSync skips a live pid whose command identity does not match', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-sidecar-identity-'));
  trackDirectory(userDataPath);
  const statePath = getManagedSidecarStatePath(userDataPath);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    pid: 210124,
    command: 'python -m sidecar',
  }), 'utf8');
  const logs = [];
  let killAttempted = false;

  const result = shutdownManagedSidecarSync({
    userDataPath,
    platform: 'win32',
    spawnSyncImpl: () => {
      killAttempted = true;
      return { status: 0 };
    },
    isProcessAliveImpl: () => true,
    getProcessCommandLineSyncImpl: () => 'C:\\Windows\\System32\\notepad.exe',
    logger: (level, event, details) => logs.push({ level, event, details }),
  });

  assert.deepEqual(result, {
    hadState: true,
    killed: false,
    pid: 210124,
    skipped: 'identity_unconfirmed',
  });
  assert.equal(killAttempted, false);
  assert.equal(fs.existsSync(statePath), true);
  assert.ok(logs.some((entry) => (
    entry.event === 'sidecar.force_kill_identity_unconfirmed'
    && entry.details.pid === 210124
  )));
});

test('shutdownManagedSidecarSync clears invalid state without killing', () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-sidecar-invalid-'));
  trackDirectory(userDataPath);
  const statePath = getManagedSidecarStatePath(userDataPath);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({ pid: 'nope' }), 'utf8');
  let killed = false;

  const result = shutdownManagedSidecarSync({
    userDataPath,
    platform: 'win32',
    spawnSyncImpl: () => {
      killed = true;
      return { status: 0 };
    },
  });

  assert.deepEqual(result, { hadState: false, killed: false, pid: 0 });
  assert.equal(killed, false);
  assert.equal(fs.existsSync(statePath), false);
});
