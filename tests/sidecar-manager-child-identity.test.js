'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { SidecarManager } = require('../services/backend/sidecar-manager');
const {
  cleanupTrackedResources,
  createTrackedTempDir,
} = require('./helpers/resource-cleanup');

test.afterEach(async () => {
  await cleanupTrackedResources();
});

function makeFakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

test('late events from an older child do not clear or fail the current sidecar', async () => {
  const children = [makeFakeChild(900001), makeFakeChild(900002)];
  let spawnIndex = 0;
  const manager = new SidecarManager({
    mode: 'managed-dev',
    userDataPath: createTrackedTempDir('jenny-sidecar-child-identity-data-'),
    repoRoot: createTrackedTempDir('jenny-sidecar-child-identity-repo-'),
    pythonExecutable: process.execPath,
    launchCommand: process.execPath,
    launchArgs: ['--fake-sidecar'],
    spawnImpl: () => children[spawnIndex++],
    killProcessTreeImpl: async () => ({ terminated: false }),
    getProcessCommandLineImpl: async () => '',
  });
  manager._waitForSpawnSettle = async () => false;

  await manager.start();
  const olderChild = manager.process;
  manager.process = null;
  await manager.start();
  const currentChild = manager.process;

  olderChild.emit('error', new Error('late spawn failure'));
  olderChild.emit('exit', 9, null);

  assert.equal(manager.process, currentChild);
  assert.equal(manager.getStatus().phase, 'ready');
  assert.equal(manager.lastSpawnError, null);
  assert.equal(manager.lastExitInfo, null);
});
