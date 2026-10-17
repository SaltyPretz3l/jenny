'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { SidecarManager } = require('../services/backend/sidecar-manager');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

const BOOTLOADER = 4100;
const INTERPRETER = 4101;

// Packaged Linux onefile topology: Electron tracks the bootloader, its single
// same-binary child is the interpreter that owns the process ledger. SIGKILL on
// the bootloader cannot reach its signal forwarder, so the interpreter survives.
function buildOnefileManager({ interpreterDies = true } = {}) {
  const alive = new Set([BOOTLOADER, INTERPRETER]);
  const kills = [];
  let record = { pid: BOOTLOADER, command: 'jenny-sidecar', launchSource: 'packaged-binary' };
  const manager = new SidecarManager({
    userDataPath: createTrackedTempDir('jenny-onefile-stop-'),
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    launchSource: 'packaged-binary',
    findFrozenInterpreterImpl: (pid) => (pid === BOOTLOADER && alive.has(INTERPRETER)
      ? { pid: INTERPRETER } : null),
    killProcessTreeImpl: async (pid, options) => {
      kills.push({ pid, force: options.force, confirmExit: options.confirmExit });
      if (pid === BOOTLOADER) alive.delete(BOOTLOADER);
      if (pid === INTERPRETER && interpreterDies) alive.delete(INTERPRETER);
      return { terminated: !alive.has(pid) };
    },
  });
  manager.stateStore = {
    read: () => record,
    write: (value) => { record = value; },
    delete: () => { record = null; },
  };
  manager._waitForProcessExit = async () => false;
  manager.process = { pid: BOOTLOADER, exitCode: null };
  return { manager, kills, alive, getRecord: () => record };
}

test('onefile force-stop terminates and confirms the interpreter before the bootloader', async () => {
  const { manager, kills, alive, getRecord } = buildOnefileManager();
  const result = await manager.stop({ gracefulDeadlineAt: Date.now() });
  assert.deepEqual(kills.map((call) => call.pid), [INTERPRETER, BOOTLOADER]);
  assert.ok(kills.every((call) => call.force === true && call.confirmExit === true));
  assert.equal(alive.size, 0);
  assert.equal(result.exitConfirmed, true);
  assert.equal(getRecord(), null);
});

test('onefile force-stop does not treat bootloader exit alone as shutdown confirmation', async () => {
  const { manager, kills, alive, getRecord } = buildOnefileManager({ interpreterDies: false });
  const result = await manager.stop({ gracefulDeadlineAt: Date.now() });
  assert.equal(result.exitConfirmed, false);
  assert.ok(alive.has(INTERPRETER));
  // The bootloader is kept so the retained ownership record still names a live tree.
  assert.deepEqual(kills.map((call) => call.pid), [INTERPRETER]);
  assert.notEqual(getRecord(), null);
  assert.match(manager.getStatus().detail, /not confirmed/);
});

test('onefile stale-state cleanup kills the interpreter of a previous run too', async (t) => {
  const { manager, kills, alive, getRecord } = buildOnefileManager();
  manager.process = null;
  manager.getProcessCommandLineImpl = async () => 'jenny-sidecar';
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(signal, 0);
    if (!alive.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  assert.equal(await manager.cleanupStaleState(), false);
  assert.deepEqual(kills.map((call) => call.pid), [INTERPRETER, BOOTLOADER]);
  assert.equal(getRecord(), null);
});

test('a source (non-packaged) sidecar never resolves an onefile interpreter', async () => {
  const kills = [];
  let resolved = 0;
  const manager = new SidecarManager({
    userDataPath: createTrackedTempDir('jenny-source-stop-'),
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    findFrozenInterpreterImpl: () => { resolved += 1; return { pid: INTERPRETER }; },
    killProcessTreeImpl: async (pid) => { kills.push(pid); return { terminated: true }; },
  });
  manager._waitForProcessExit = async () => false;
  manager.process = { pid: BOOTLOADER, exitCode: null };
  const result = await manager.stop({ gracefulDeadlineAt: Date.now() });
  assert.equal(result.exitConfirmed, true);
  assert.deepEqual(kills, [BOOTLOADER]);
  assert.equal(resolved, 0);
});

// A live interpreter whose /proc identity is unreadable: real discovery over a fake /proc
// cannot verify the child, so the topology is unresolved rather than childless.
function unreadableInterpreterDiscovery() {
  const fs = require('node:fs');
  const path = require('node:path');
  const { frozenInterpreter } = require('../services/backend/owned-process-recovery');
  const procRoot = createTrackedTempDir('jenny-onefile-proc-');
  for (const [pid, ppid] of [[BOOTLOADER, 1], [INTERPRETER, BOOTLOADER]]) {
    fs.mkdirSync(path.join(procRoot, String(pid)));
    fs.writeFileSync(path.join(procRoot, String(pid), 'stat'), `${pid} (jenny-sidecar) S ${ppid} ${pid} ${pid} 0`);
  }
  const bootloader = { pid: BOOTLOADER, pgid: BOOTLOADER, uid: 1000, start: 'boot:1',
    exe: '/opt/Jenny/resources/sidecar/jenny-sidecar', command_hash: 'a'.repeat(64) };
  let reads = 0;
  const read = (pid) => {
    reads += 1;
    return pid === BOOTLOADER ? { state: 'alive', identity: bootloader } : { state: 'unknown' };
  };
  return { find: (pid) => frozenInterpreter(pid, { platform: 'linux', procRoot, read }), reads: () => reads };
}

test('onefile force-stop with an unreadable live interpreter identity keeps ownership', async () => {
  const { manager, kills, alive, getRecord } = buildOnefileManager();
  const discovery = unreadableInterpreterDiscovery();
  manager.findFrozenInterpreterImpl = discovery.find;
  const result = await manager.stop({ gracefulDeadlineAt: Date.now() });
  assert.equal(discovery.reads(), 2, 'the bootloader and its child were both probed');
  assert.equal(result.exitConfirmed, false);
  assert.deepEqual(kills, [], 'the bootloader stays so the retained record names a live tree');
  assert.ok(alive.has(BOOTLOADER) && alive.has(INTERPRETER));
  assert.notEqual(getRecord(), null);
});

test('onefile stale-state cleanup with an unreadable interpreter identity stays unresolved', async (t) => {
  const { manager, kills, alive, getRecord } = buildOnefileManager();
  manager.findFrozenInterpreterImpl = unreadableInterpreterDiscovery().find;
  manager.process = null;
  manager.getProcessCommandLineImpl = async () => 'jenny-sidecar';
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(signal, 0);
    if (!alive.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  assert.equal(await manager.cleanupStaleState(), true, 'ownership remains unresolved');
  assert.deepEqual(kills, []);
  assert.notEqual(getRecord(), null);
});

// More numeric /proc entries than discovery inspects, with the live interpreter beyond them:
// an incomplete enumeration never establishes that the bootloader is childless.
function truncatedDiscovery(t) {
  const fs = require('node:fs');
  const path = require('node:path');
  const { frozenInterpreter } = require('../services/backend/owned-process-recovery');
  const procRoot = createTrackedTempDir('jenny-onefile-proc-many-');
  fs.mkdirSync(path.join(procRoot, String(INTERPRETER)));
  fs.writeFileSync(path.join(procRoot, String(INTERPRETER), 'stat'),
    `${INTERPRETER} (jenny-sidecar) S ${BOOTLOADER} ${INTERPRETER} ${INTERPRETER} 0`);
  const names = [...Array.from({ length: 65536 }, (_, index) => String(100000 + index)), String(INTERPRETER)];
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (dir, ...rest) => (dir === procRoot ? names : readdir.call(fs, dir, ...rest)));
  const identity = (pid) => ({ pid, pgid: pid, uid: 1000, start: `boot:${pid}`,
    exe: '/opt/Jenny/resources/sidecar/jenny-sidecar', command_hash: 'a'.repeat(64) });
  const read = (pid) => ([BOOTLOADER, INTERPRETER].includes(pid)
    ? { state: 'alive', identity: identity(pid) } : { state: 'missing' });
  return (pid) => frozenInterpreter(pid, { platform: 'linux', procRoot, read });
}

test('onefile force-stop keeps ownership when the interpreter lies beyond the inspected /proc prefix', async (t) => {
  const { manager, kills, alive, getRecord } = buildOnefileManager();
  manager.findFrozenInterpreterImpl = truncatedDiscovery(t);
  const result = await manager.stop({ gracefulDeadlineAt: Date.now() });
  assert.equal(result.exitConfirmed, false);
  assert.deepEqual(kills, []);
  assert.ok(alive.has(BOOTLOADER) && alive.has(INTERPRETER));
  assert.notEqual(getRecord(), null);
});
