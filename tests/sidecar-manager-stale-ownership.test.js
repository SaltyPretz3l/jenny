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

function buildManager(t, killImpl) {
  const oldPid = 7654321;
  const command = `${process.execPath} --fake-sidecar`;
  const events = [];
  let alive = true;
  let probeImpl = () => command;
  let terminateImpl = killImpl;
  const originalRecord = { pid: oldPid, command };
  let record = originalRecord;
  let spawnCount = 0;
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, oldPid);
    assert.equal(signal, 0);
    if (!alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  });
  const manager = new SidecarManager({
    userDataPath: createTrackedTempDir('jenny-stale-ownership-data-'),
    repoRoot: process.cwd(),
    pythonExecutable: process.execPath,
    launchArgs: ['--fake-sidecar'],
    spawnImpl: () => {
      events.push('spawn');
      spawnCount += 1;
      const child = new EventEmitter();
      child.pid = oldPid + 1;
      child.exitCode = null;
      child.stderr = new EventEmitter();
      return child;
    },
    killProcessTreeImpl: (pid, options) => {
      assert.equal(pid, oldPid);
      assert.equal(options.force, true);
      events.push('kill');
      return terminateImpl();
    },
    getProcessCommandLineImpl: async (pid) => {
      assert.equal(pid, oldPid);
      events.push('probe');
      return probeImpl();
    },
  });
  manager.stateStore = {
    read: () => record,
    write: (value) => { events.push('write'); record = value; },
    delete: () => { events.push('delete'); record = null; },
  };
  manager._waitForSpawnSettle = async () => false;
  manager._waitForProcessExit = async () => false;
  // Model a surviving child whose handle is retired by an unconfirmed stop.
  manager.process = { pid: oldPid, exitCode: null };
  return {
    manager,
    originalRecord,
    events,
    getRecord: () => record,
    getSpawnCount: () => spawnCount,
    setAlive: (value) => { alive = value; },
    setProbe: (value) => { probeImpl = value; },
    setKill: (value) => { terminateImpl = value; },
  };
}

async function assertBlockedRetry(fixture) {
  const { manager, originalRecord, events, getRecord, getSpawnCount } = fixture;
  const stopped = await manager.stop();
  assert.equal(stopped.exitConfirmed, false);
  assert.equal(manager.process, null);
  assert.equal(getRecord(), originalRecord);
  events.length = 0;
  const failure = await manager.retryStart().then(() => null, (error) => error);
  assert.equal(getSpawnCount(), 0, 'unconfirmed termination must block replacement spawn');
  assert.equal(getRecord(), originalRecord, 'unconfirmed termination must retain ownership');
  assert.ok(failure instanceof Error, 'startup must reject while ownership is unresolved');
  assert.match(failure.message, /exit was not confirmed/i);
  assert.equal(manager.getStatus().phase, 'failed');
  assert.match(manager.getStatus().detail, /Backend failed to start.*exit was not confirmed/i);
  assert.equal(events[0], 'probe', 'retry must re-probe identity before killing');
  assert.equal(events.includes('delete'), false);
}

for (const [label, killImpl] of [
  ['false result', async () => ({ terminated: false })],
  ['undefined result', async () => undefined],
  ['rejected kill', async () => { throw new Error('kill rejected'); }],
  ['thrown kill', () => { throw new Error('kill threw'); }],
]) {
  test(`surviving child retains ownership and blocks retry after ${label}`, async (t) => {
    await assertBlockedRetry(buildManager(t, killImpl));
  });
}

test('a later retry clears ownership and spawns once after confirmed exit', async (t) => {
  const fixture = buildManager(t, async () => ({ terminated: false }));
  await assertBlockedRetry(fixture);
  fixture.events.length = 0;
  fixture.setAlive(false);
  const status = await fixture.manager.retryStart();
  assert.equal(status.phase, 'ready');
  assert.equal(fixture.getSpawnCount(), 1);
  assert.notEqual(fixture.getRecord(), fixture.originalRecord);
  assert.ok(fixture.events.indexOf('delete') < fixture.events.indexOf('spawn'));
  assert.equal(fixture.events.includes('kill'), false);
});

test('a later retry clears ownership and spawns once after confirmed termination', async (t) => {
  const fixture = buildManager(t, async () => ({ terminated: false }));
  await assertBlockedRetry(fixture);
  fixture.events.length = 0;
  fixture.setKill(async () => ({ terminated: true }));
  const status = await fixture.manager.retryStart();
  assert.equal(status.phase, 'ready');
  assert.equal(fixture.getSpawnCount(), 1);
  assert.equal(fixture.events[0], 'probe');
  assert.ok(fixture.events.indexOf('kill') < fixture.events.indexOf('delete'));
  assert.ok(fixture.events.indexOf('delete') < fixture.events.indexOf('spawn'));
});

test('follow-up identity mismatch confirms retirement despite an undefined kill result', async (t) => {
  const fixture = buildManager(t, async () => undefined);
  fixture.manager.process = null;
  fixture.setKill(async () => {
    fixture.setProbe(() => 'unrelated-process');
  });
  assert.equal((await fixture.manager.start()).phase, 'ready');
  assert.equal(fixture.getSpawnCount(), 1);
  assert.deepEqual(fixture.events.slice(0, 4), ['probe', 'kill', 'probe', 'delete']);
});

test('follow-up disappearance confirms retirement despite a rejected kill', async (t) => {
  const fixture = buildManager(t, async () => ({ terminated: false }));
  fixture.manager.process = null;
  fixture.setKill(async () => {
    fixture.setAlive(false);
    throw new Error('kill rejected after exit');
  });
  assert.equal((await fixture.manager.start()).phase, 'ready');
  assert.equal(fixture.getSpawnCount(), 1);
  assert.ok(fixture.events.indexOf('delete') < fixture.events.indexOf('spawn'));
});

for (const [label, probe] of [
  ['empty identity', () => ''],
  ['failed identity probe', () => { throw new Error('probe unavailable'); }],
]) {
  test(`follow-up ${label} does not prove termination of a live process`, async (t) => {
    const fixture = buildManager(t, async () => undefined);
    fixture.manager.process = null;
    fixture.setKill(async () => { fixture.setProbe(probe); });
    const failure = await fixture.manager.start().then(() => null, (error) => error);
    assert.equal(fixture.getSpawnCount(), 0, 'unknown identity must block replacement spawn');
    assert.equal(fixture.getRecord(), fixture.originalRecord);
    assert.ok(failure instanceof Error);
    assert.equal(fixture.manager.getStatus().phase, 'failed');
  });
}

for (const [label, probe] of [
  ['empty identity', () => ''],
  ['failed identity probe', () => { throw new Error('probe unavailable'); }],
]) {
  test(`initial ${label} on a record this run retained keeps ownership and blocks retry`, async (t) => {
    const fixture = buildManager(t, async () => ({ terminated: false }));
    await assertBlockedRetry(fixture);
    fixture.events.length = 0;
    fixture.setProbe(probe);
    const failure = await fixture.manager.retryStart().then(() => null, (error) => error);
    assert.ok(failure instanceof Error);
    assert.equal(fixture.getSpawnCount(), 0, 'unknown identity must not permit a replacement');
    assert.equal(fixture.getRecord(), fixture.originalRecord);
    assert.equal(fixture.events.includes('kill'), false, 'unknown identity must not kill');
  });

  test(`initial ${label} on a previous run's record still retires it`, async (t) => {
    const fixture = buildManager(t, async () => ({ terminated: false }));
    fixture.manager.process = null;
    fixture.setProbe(probe);
    assert.equal((await fixture.manager.start()).phase, 'ready');
    assert.equal(fixture.getSpawnCount(), 1);
    assert.equal(fixture.events.includes('kill'), false);
  });
}
