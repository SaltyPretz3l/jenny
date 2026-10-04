'use strict';
// IDE-004: on non-Windows the default runner must be able to confirm cleanup of
// a normal run, or production resource admission keeps the run lock forever.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWorkspaceTestRunnerService } = require('../services/workspace-test-runner-service');

test('IDE-004: a normal POSIX run through production resource admission releases and a second run is admitted', async (t) => {
  const { ResourceBroker } = require('../services/session-runtime/resource-broker');
  const { PhysicalPathResolver } = require('../services/session-runtime/physical-paths');
  const { runTestCommand } = require('../services/backend/workspace-test-runner-runner');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-posix-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const broker = new ResourceBroker({ createId: (() => { let n = 0; return () => `lease-${++n}`; })() });
  const pathResolver = new PhysicalPathResolver();
  const probes = [];
  const fakeSpawn = () => {
    const handlers = {};
    const reg = (event, cb) => { (handlers[event] = handlers[event] || []).push(cb); };
    setImmediate(() => (handlers.close || []).forEach((cb) => cb(0, null)));
    return { pid: 4242, stdout: { on() {} }, stderr: { on() {} }, once: reg, on: reg };
  };
  const service = createWorkspaceTestRunnerService({
    // The REAL runner with the POSIX platform and fake process seams: the
    // group is already empty (ESRCH), exactly a normal natural exit.
    runner: {
      runTestCommand: (opts) => runTestCommand({
        ...opts,
        platform: 'linux',
        spawn: fakeSpawn,
        processKillImpl: (pid, signal) => { probes.push([pid, signal]); throw Object.assign(new Error('gone'), { code: 'ESRCH' }); },
        killProcessTreeImpl: async () => assert.fail('an empty group must never be signalled'),
      }),
    },
    rootProvider: () => root,
    configProvider: () => [{ id: 'unit', label: 'Unit', command: 'npm test', cwd: '.' }],
    resourceAdmissionProvider: () => ({ broker, pathResolver }),
  });

  const first = await service.run({ configId: 'unit' });
  assert.equal(first.status, 'passed');
  assert.equal(first.terminationConfirmed, true);
  assert.equal(service.getState().activeRun, null, 'the run lock released after a normal run');
  assert.equal(broker.snapshot().lease_count, 0);

  const second = await service.run({ configId: 'unit' });
  assert.equal(second.status, 'passed', 'a second run is admitted, not refused as locked');
  assert.deepEqual(probes, [[-4242, 0], [-4242, 0]]);
});
