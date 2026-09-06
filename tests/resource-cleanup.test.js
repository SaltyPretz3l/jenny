'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanupTrackedResources,
  createTrackedTempDir,
  expandProcessTreePids,
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

test('process cleanup expands tracked roots to recursive descendants', () => {
  const expanded = expandProcessTreePids(new Set([10]), [
    { pid: 10, ppid: 1 },
    { pid: 11, ppid: 10 },
    { pid: 12, ppid: 11 },
    { pid: 13, ppid: 12 },
    { pid: 20, ppid: 1 },
  ]);

  assert.deepEqual([...expanded].sort((a, b) => a - b), [10, 11, 12, 13]);
});

test('process cleanup ignores malformed process-list rows while expanding descendants', () => {
  const expanded = expandProcessTreePids(new Set([30]), [
    { pid: 31, ppid: 30 },
    { pid: 'not-a-pid', ppid: 30 },
    { pid: 32, ppid: 'not-a-ppid' },
    null,
  ]);

  assert.deepEqual([...expanded].sort((a, b) => a - b), [30, 31]);
});
