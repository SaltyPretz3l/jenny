'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupTrackedResources,
  createTrackedTempDir,
  selectOwnedKillTargets,
  trackCloseable,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

test('createTrackedTempDir removes scratch directories during cleanup', async () => {
  const tempDir = createTrackedTempDir('jenny-cleanup-dir-');
  fs.writeFileSync(path.join(tempDir, 'note.txt'), 'cleanup me', 'utf8');

  await cleanupTrackedResources();

  assert.equal(fs.existsSync(tempDir), false);
});

test('tracked closeables run once even when cleanup is called repeatedly', async () => {
  let closeCalls = 0;
  trackCloseable({
    async close() {
      closeCalls += 1;
    },
  });

  await cleanupTrackedResources();
  await cleanupTrackedResources();

  assert.equal(closeCalls, 1);
});

test('tracked closeables run before tracked directories are removed', async () => {
  const tempDir = createTrackedTempDir('jenny-cleanup-order-');
  let directoryExistsDuringClose = false;
  trackCloseable({
    async close() {
      directoryExistsDuringClose = fs.existsSync(tempDir);
      fs.writeFileSync(path.join(tempDir, 'closed.txt'), 'closed', 'utf8');
    },
  });

  await cleanupTrackedResources();

  assert.equal(directoryExistsDuringClose, true);
  assert.equal(fs.existsSync(tempDir), false);
});

test('tracked closeables call stop when stop is the available shutdown method', async () => {
  let stopCalls = 0;
  trackCloseable({
    async stop() {
      stopCalls += 1;
    },
  });

  await cleanupTrackedResources();

  assert.equal(stopCalls, 1);
});

test('global cleanup does not force-kill its own test runner pid', () => {
  // The kill set comes from pid FILES under tracked directories -- not from
  // trackProcess() -- so this fixture has to write a sidecar-state.json naming a
  // live pid, or the cleanup enumerates nothing and the test passes without ever
  // reaching the guard. Runs in a child process so that a regressed guard kills
  // the child rather than this suite's runner.
  const helperPath = path.join(__dirname, 'helpers', 'resource-cleanup.js');
  const processUtilsPath = require.resolve('../services/backend/process-utils');
  const script = [
    'const fs = require("fs");',
    'const os = require("os");',
    'const nodePath = require("path");',
    // Patch BEFORE requiring the helper: the helper destructures killProcessTree at
    // require time, so a later property assignment could not be intercepted.
    `const processUtils = require(${JSON.stringify(processUtilsPath)});`,
    'const killCalls = [];',
    'processUtils.killProcessTree = async (pid) => { killCalls.push(pid); };',
    'const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "jenny-cleanup-guard-"));',
    'fs.mkdirSync(nodePath.join(dir, "backend-sidecar"), { recursive: true });',
    'fs.writeFileSync(nodePath.join(dir, "backend-sidecar", "sidecar-state.json"),',
    '  JSON.stringify({ pid: process.pid }));',
    `const { cleanupTrackedResources, trackDirectory } = require(${JSON.stringify(helperPath)});`,
    'trackDirectory(dir);',
    'cleanupTrackedResources().then(() => {',
    '  process.stdout.write(JSON.stringify({ ownPid: process.pid, killCalls }));',
    '});',
  ].join('\n');
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  });

  assert.equal(
    result.status,
    0,
    `cleanup probe must exit cleanly: ${result.stderr || result.error || ''}`
  );
  const observed = JSON.parse(result.stdout);
  assert.ok(
    observed.killCalls.length > 0 || observed.ownPid > 0,
    'probe must have run the cleanup path'
  );
  assert.equal(
    observed.killCalls.includes(observed.ownPid),
    false,
    'global cleanup must never submit its own pid for force-kill, even when a tracked pid file names it'
  );
});

const sorted = (pids) => [...pids].sort((a, b) => a - b);
const liveHandle = () => ({ exitCode: null, signalCode: null });
const exitedHandle = () => ({ exitCode: 0, signalCode: null });

test('process cleanup expands tracked roots to recursive descendants', () => {
  const targets = selectOwnedKillTargets([{ pid: 10, createdNotAfterMs: 1000, handle: liveHandle() }], [
    { pid: 10, ppid: 1, createdMs: 900 },
    { pid: 11, ppid: 10, createdMs: 950 },
    { pid: 12, ppid: 11, createdMs: 960 },
    { pid: 13, ppid: 12, createdMs: 970 },
    { pid: 20, ppid: 1, createdMs: 980 },
  ]);

  assert.deepEqual(sorted(targets), [10, 11, 12, 13]);
});

test('process cleanup ignores malformed process-list rows while expanding descendants', () => {
  const targets = selectOwnedKillTargets([{ pid: 30, createdNotAfterMs: 1000, handle: liveHandle() }], [
    { pid: 30, ppid: 1, createdMs: 900 },
    { pid: 31, ppid: 30, createdMs: 950 },
    { pid: 'not-a-pid', ppid: 30 },
    { pid: 32, ppid: 'not-a-ppid' },
    null,
  ]);

  assert.deepEqual(sorted(targets), [30, 31]);
});

// Windows reuses a freed pid within seconds under the full suite: an exited
// crash child's pid named renderer-proactive's freshly spawned test process, and
// cleanup's taskkill /T /F killed it mid-boot (exit 1, no output).
test('an exited tracked process is never a kill target, nor is the process that reused its pid', () => {
  const targets = selectOwnedKillTargets(
    [{ pid: 40, createdNotAfterMs: 1000, handle: exitedHandle(), exitedAtMs: 1200 }],
    [
      { pid: 40, ppid: 7, createdMs: 1500 },
      { pid: 41, ppid: 40, createdMs: 1600 },
    ]
  );

  assert.deepEqual(sorted(targets), []);
});

test('a bare tracked pid now held by a later process is not killed', () => {
  const targets = selectOwnedKillTargets([{ pid: 50, createdNotAfterMs: 1000, handle: null }], [
    { pid: 50, ppid: 7, createdMs: 1500 },
    { pid: 51, ppid: 50, createdMs: 1600 },
  ]);

  assert.deepEqual(sorted(targets), []);
});

test('a pid-file root reused after its record was written is not killed', () => {
  const targets = selectOwnedKillTargets([{ pid: 60, createdNotAfterMs: 1000 }], [
    { pid: 60, ppid: 7, createdMs: 1001 },
  ]);

  assert.deepEqual(sorted(targets), []);
});

test('orphans of an exited root are reaped only when created before it exited and before a reuser', () => {
  const targets = selectOwnedKillTargets(
    [{ pid: 70, createdNotAfterMs: 1000, handle: exitedHandle(), exitedAtMs: 2000 }],
    [
      { pid: 71, ppid: 70, createdMs: 1100 },
      { pid: 72, ppid: 71, createdMs: 1150 },
      { pid: 70, ppid: 7, createdMs: 1300 },
      { pid: 73, ppid: 70, createdMs: 1400 },
    ]
  );

  assert.deepEqual(sorted(targets), [71, 72]);
});

test('a descendant link older than its parent is a stale ppid, not a child', () => {
  const targets = selectOwnedKillTargets([{ pid: 80, createdNotAfterMs: 1000, handle: liveHandle() }], [
    { pid: 80, ppid: 1, createdMs: 900 },
    { pid: 81, ppid: 80, createdMs: 500 },
    { pid: 82, ppid: 80, createdMs: 950 },
  ]);

  assert.deepEqual(sorted(targets), [80, 82]);
});

test('without creation times a dead root contributes nothing and a live root keeps its tree', () => {
  const targets = selectOwnedKillTargets(
    [
      { pid: 90, createdNotAfterMs: 1000, handle: exitedHandle(), exitedAtMs: 1200 },
      { pid: 95, createdNotAfterMs: 1000, handle: liveHandle() },
    ],
    [
      { pid: 91, ppid: 90 },
      { pid: 95, ppid: 1 },
      { pid: 96, ppid: 95 },
    ]
  );

  assert.deepEqual(sorted(targets), [95, 96]);
});

test('an unreadable process table degrades to the un-exited roots only', () => {
  const targets = selectOwnedKillTargets(
    [
      { pid: 100, createdNotAfterMs: 1000, handle: liveHandle() },
      { pid: 101, createdNotAfterMs: 1000, handle: exitedHandle(), exitedAtMs: 1200 },
      { pid: 102, createdNotAfterMs: 1000 },
    ],
    []
  );

  assert.deepEqual(sorted(targets), [100, 102]);
});

test('cleanup does not force-kill a tracked child that already exited', async () => {
  // Runs in a child process so the patched killProcessTree stays local.
  const helperPath = path.join(__dirname, 'helpers', 'resource-cleanup.js');
  const processUtilsPath = require.resolve('../services/backend/process-utils');
  const script = [
    'const { spawn } = require("child_process");',
    `const processUtils = require(${JSON.stringify(processUtilsPath)});`,
    'const killCalls = [];',
    'processUtils.killProcessTree = async (pid) => { killCalls.push(pid); };',
    `const { cleanupTrackedResources, trackProcess } = require(${JSON.stringify(helperPath)});`,
    'const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true });',
    'trackProcess(child);',
    'child.once("exit", async () => {',
    '  await cleanupTrackedResources();',
    '  process.stdout.write(JSON.stringify({ exitedPid: child.pid, killCalls }));',
    '});',
  ].join('\n');
  const probe = spawn(process.execPath, ['-e', script], { windowsHide: true });
  let stdout = '';
  let stderr = '';
  probe.stdout.on('data', (chunk) => { stdout += chunk; });
  probe.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve) => probe.once('close', resolve));

  assert.equal(code, 0, `cleanup probe must exit cleanly: ${stderr}`);
  const observed = JSON.parse(stdout);
  assert.ok(observed.exitedPid > 0, 'probe must have tracked a real child');
  assert.deepEqual(observed.killCalls, [], 'an exited child pid may already belong to another process');
});
