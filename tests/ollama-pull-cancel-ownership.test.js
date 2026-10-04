'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const { OllamaPullService } = require('../services/ollama-pull-service');

const MODEL = 'gemma3:latest';
const TERMINAL_STATUSES = new Set(['failed', 'cancelled', 'completed']);

function createFixture(t, killProcessTreeImpl = async () => ({ terminated: false })) {
  const children = [];
  const events = [];
  const service = new OllamaPullService({
    spawnImpl: () => {
      const child = new EventEmitter();
      child.pid = 7171 + children.length;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      children.push(child);
      return child;
    },
    inactivityMs: 60_000,
    killProcessTreeImpl,
  });
  service.on('progress', (event) => events.push(event));
  t.after(() => {
    for (const child of children) child.emit('exit', 1);
  });
  const operation = service.start({ model: MODEL, requestId: 'original-pull' });
  return { service, operation, children, events };
}

function terminalEvents(events, requestId = 'original-pull') {
  return events.filter((event) => event.requestId === requestId && TERMINAL_STATUSES.has(event.status));
}

test('surviving child output cannot re-arm inactivity after failed cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const timerSpy = t.mock.method(global, 'setTimeout');
  const { service, operation, children } = createFixture(t);
  const cancelled = await service.cancel({ requestId: operation.requestId });
  assert.equal(cancelled.code, 'termination_failed');
  assert.equal((await operation.promise).status, 'failed');
  const timersAfterSettlement = timerSpy.mock.callCount();

  children[0].stdout.emit('data', 'pulling abc123 50% 10 MB/20 MB\r');
  children[0].stderr.emit('data', 'success\n');

  assert.equal(timerSpy.mock.callCount(), timersAfterSettlement, 'settled output must not schedule inactivity timers');
});

test('surviving child output cannot emit progress or mutate the settled result', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { service, operation, children, events } = createFixture(t);
  await service.cancel({ requestId: operation.requestId });
  const settled = await operation.promise;
  const eventCount = events.length;
  t.mock.timers.tick(1_000);

  children[0].stdout.emit('data', 'pulling abc123 50% 10 MB/20 MB\r');
  children[0].stderr.emit('data', 'success\n');

  assert.equal(events.length, eventCount, 'settled output must not emit progress');
  for (const [key, value] of Object.entries(settled)) {
    assert.equal(operation[key], value, `settled ${key} must stay unchanged`);
  }
  assert.equal(terminalEvents(events).length, 1);
});

for (const failure of ['unconfirmed', 'rejected']) {
  test(`${failure} termination keeps the model busy without spawning a second child`, async (t) => {
    const { service, operation, children } = createFixture(t, async () => {
      if (failure === 'rejected') throw new Error('termination unavailable');
      return { terminated: false };
    });
    const cancelled = await service.cancel({ model: MODEL });
    assert.equal(cancelled.cancelled, false);
    assert.equal(cancelled.termination_confirmed, false);
    assert.equal(cancelled.code, 'termination_failed');

    const retry = service.start({ model: MODEL, requestId: 'retry-pull' });

    assert.equal(children.length, 1, 'unresolved child must block another spawn');
    assert.equal(retry, operation, 'retry must use the existing busy entry');
    assert.equal(service.activeByModel.size, 1);
    assert.equal(service.activeByRequestId.size, 1);
    assert.equal((await service.delete({ model: MODEL })).code, 'pull_in_progress');
  });
}

test('shutdown retries unresolved termination and waits without changing settled state', async (t) => {
  const kills = [];
  let releaseKill;
  t.after(() => releaseKill?.({ terminated: false }));
  const { service, operation, children, events } = createFixture(t, async (pid, options) => {
    kills.push({ pid, options });
    if (kills.length === 1) return { terminated: false };
    return new Promise((resolve) => { releaseKill = resolve; });
  });
  await service.cancel({ requestId: operation.requestId });
  const settled = await operation.promise;
  const eventCount = events.length;
  let signals = 0;
  children[0].kill = () => { signals += 1; };

  assert.equal(service.signalActive(), 1, 'shutdown must still own the surviving child');
  assert.equal(signals, 1);
  assert.equal(operation.status, settled.status, 'shutdown must preserve the terminal status');
  let drained = false;
  const firstDrain = service.drainActive().then((count) => { drained = true; return count; });
  const sharedDrain = service.drainActive();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(kills.length, 2, 'shutdown must retry termination of the original child');
  assert.equal(kills[1].pid, children[0].pid);
  assert.equal(kills[1].options.confirmExit, true);
  assert.equal(drained, false, 'drain must await the termination attempt');
  releaseKill({ terminated: false });
  assert.deepEqual(await Promise.all([firstDrain, sharedDrain]), [1, 1]);
  assert.equal(service.activeByRequestId.size, 1, 'another unconfirmed attempt must retain ownership');

  const finalDrain = service.drainActive();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(kills.length, 3);
  releaseKill({ terminated: true });
  assert.equal(await finalDrain, 1);
  assert.equal(service.activeByRequestId.size, 0);
  assert.equal(service.activeByModel.size, 0);
  assert.equal(await service.drainActive(), 0);
  assert.equal(operation.status, settled.status);
  assert.equal(events.length, eventCount);
  assert.equal(terminalEvents(events).length, 1);
});

test('eventual exit retires unresolved ownership and admits a retry with one original terminal event', async (t) => {
  const { service, operation, children, events } = createFixture(t);
  await service.cancel({ requestId: operation.requestId });
  const settled = await operation.promise;
  assert.equal(service.activeByRequestId.size, 1, 'settlement must retain the surviving child');
  const eventCount = events.length;

  children[0].emit('exit', 1);

  assert.equal(service.activeByRequestId.size, 0);
  assert.equal(service.activeByModel.size, 0);
  assert.equal(events.length, eventCount, 'eventual exit must not settle the operation again');
  assert.equal(operation.status, settled.status);
  const retry = service.start({ model: MODEL, requestId: 'retry-pull' });
  assert.equal(children.length, 2, 'exit must permit the next pull');
  assert.notEqual(retry, operation);
  children[0].stdout.emit('data', 'success\n');
  children[1].emit('exit', 0);
  assert.equal((await retry.promise).status, 'completed');
  assert.equal(terminalEvents(events).length, 1, 'first pull must have exactly one terminal event');
});

test('a retry that confirms termination of a retained child reports it confirmed', async (t) => {
  let confirm = false;
  const { service, operation } = createFixture(t, async () => ({ terminated: confirm }));
  const first = await service.cancel({ requestId: operation.requestId });
  assert.equal(first.termination_confirmed, false);
  confirm = true;
  const second = await service.cancel({ requestId: operation.requestId });
  assert.equal(second.termination_confirmed, true);
  assert.equal(service.activeByModel.size, 0);
});
