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
  let recoveryCalls = 0;

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
    recoverOwnedProcesses: () => { assert.equal(alive, false); recoveryCalls += 1; },
  });

  assert.deepEqual(result, { hadState: true, killed: true, pid: 210123 });
  assert.deepEqual(spawnCalls, [
    { command: 'taskkill', args: ['/PID', '210123', '/T', '/F'], timeout: 2000 },
  ]);
  assert.equal(fs.existsSync(statePath), false);
  assert.equal(recoveryCalls, 1);
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

// Packaged Linux onefile: the state pid is the bootloader, its child interpreter owns the ledger.
function writeOnefileState(prefix) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  trackDirectory(userDataPath);
  const statePath = getManagedSidecarStatePath(userDataPath);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    pid: 4200, command: 'jenny-sidecar', launchSource: 'packaged-binary',
  }), 'utf8');
  return { userDataPath, statePath };
}

function runOnefileSync(t, { userDataPath, interpreterDies }) {
  const alive = new Set([4200, 4201]);
  const signals = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    signals.push([pid, signal]);
    if (pid === 4200) alive.delete(4200);
    if (pid === 4201 && interpreterDies) alive.delete(4201);
  });
  const result = shutdownManagedSidecarSync({
    userDataPath,
    platform: 'linux',
    isProcessAliveImpl: (pid) => alive.has(pid),
    getProcessCommandLineSyncImpl: () => 'jenny-sidecar',
    findFrozenInterpreterImpl: (pid) => (pid === 4200 && alive.has(4201) ? { pid: 4201 } : null),
  });
  return { result, alive, signals };
}

test('sync onefile shutdown kills and confirms the interpreter before the bootloader', (t) => {
  const { userDataPath, statePath } = writeOnefileState('jenny-sidecar-onefile-');
  const { result, alive, signals } = runOnefileSync(t, { userDataPath, interpreterDies: true });
  assert.deepEqual(signals, [[4201, 'SIGKILL'], [4200, 'SIGKILL']]);
  assert.equal(alive.size, 0);
  assert.deepEqual(result, { hadState: true, killed: true, pid: 4200 });
  assert.equal(fs.existsSync(statePath), false);
});

test('sync onefile shutdown keeps ownership when only the bootloader could exit', (t) => {
  const { userDataPath, statePath } = writeOnefileState('jenny-sidecar-onefile-stuck-');
  const { result, alive, signals } = runOnefileSync(t, { userDataPath, interpreterDies: false });
  assert.equal(result.killed, false);
  assert.ok(alive.has(4201));
  assert.deepEqual(signals, [[4201, 'SIGKILL']]);
  assert.equal(fs.existsSync(statePath), true);
});

// Real discovery over a fake /proc whose live interpreter child has an unreadable identity.
function unreadableInterpreterDiscovery() {
  const { frozenInterpreter } = require('../services/backend/owned-process-recovery');
  const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-onefile-proc-'));
  trackDirectory(procRoot);
  for (const [pid, ppid] of [[4200, 1], [4201, 4200]]) {
    fs.mkdirSync(path.join(procRoot, String(pid)));
    fs.writeFileSync(path.join(procRoot, String(pid), 'stat'), `${pid} (jenny-sidecar) S ${ppid} ${pid} ${pid} 0`);
  }
  const bootloader = { pid: 4200, pgid: 4200, uid: 1000, start: 'boot:1',
    exe: '/opt/Jenny/resources/sidecar/jenny-sidecar', command_hash: 'a'.repeat(64) };
  const read = (pid) => (pid === 4200 ? { state: 'alive', identity: bootloader } : { state: 'unknown' });
  return (pid, options) => frozenInterpreter(pid, { ...options, procRoot, read });
}

for (const [label, findFrozenInterpreterImpl] of [
  ['an unreadable live interpreter identity', null],
  ['a throwing interpreter discovery', () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }],
]) {
  test(`sync onefile shutdown with ${label} reports no shutdown and keeps state`, (t) => {
    const { userDataPath, statePath } = writeOnefileState('jenny-sidecar-onefile-unresolved-');
    const alive = new Set([4200, 4201]);
    const signals = [];
    t.mock.method(process, 'kill', (pid, signal) => {
      signals.push([pid, signal]);
      alive.delete(pid);
    });
    const result = shutdownManagedSidecarSync({
      userDataPath,
      platform: 'linux',
      isProcessAliveImpl: (pid) => alive.has(pid),
      getProcessCommandLineSyncImpl: () => 'jenny-sidecar',
      findFrozenInterpreterImpl: findFrozenInterpreterImpl || unreadableInterpreterDiscovery(),
    });
    assert.equal(result.killed, false);
    assert.deepEqual(signals, []);
    assert.ok(alive.has(4200) && alive.has(4201));
    assert.equal(fs.existsSync(statePath), true);
  });
}

test('sync onefile shutdown keeps state when the interpreter lies beyond the inspected /proc prefix', (t) => {
  const { frozenInterpreter } = require('../services/backend/owned-process-recovery');
  const procRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jenny-onefile-proc-many-'));
  trackDirectory(procRoot);
  fs.mkdirSync(path.join(procRoot, '4201'));
  fs.writeFileSync(path.join(procRoot, '4201', 'stat'), '4201 (jenny-sidecar) S 4200 4201 4201 0');
  const names = [...Array.from({ length: 65536 }, (_, index) => String(100000 + index)), '4201'];
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (dir, ...rest) => (dir === procRoot ? names : readdir.call(fs, dir, ...rest)));
  const identity = (pid) => ({ pid, pgid: pid, uid: 1000, start: `boot:${pid}`,
    exe: '/opt/Jenny/resources/sidecar/jenny-sidecar', command_hash: 'a'.repeat(64) });
  const read = (pid) => ([4200, 4201].includes(pid) ? { state: 'alive', identity: identity(pid) } : { state: 'missing' });
  const { userDataPath, statePath } = writeOnefileState('jenny-sidecar-onefile-truncated-');
  const alive = new Set([4200, 4201]);
  const signals = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    signals.push([pid, signal]);
    alive.delete(pid);
  });
  const result = shutdownManagedSidecarSync({
    userDataPath,
    platform: 'linux',
    isProcessAliveImpl: (pid) => alive.has(pid),
    getProcessCommandLineSyncImpl: () => 'jenny-sidecar',
    findFrozenInterpreterImpl: (pid, options) => frozenInterpreter(pid, { ...options, procRoot, read }),
  });
  assert.equal(result.killed, false);
  assert.deepEqual(signals, []);
  assert.ok(alive.has(4200) && alive.has(4201));
  assert.equal(fs.existsSync(statePath), true);
});
