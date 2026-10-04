'use strict';

const { EventEmitter } = require('node:events');
const test = require('node:test');
const assert = require('node:assert/strict');
const { holdEventLoopUntilTestsFinish } = require('./helpers/event-loop-hold');

// Production timers in this module are unref'd; see the helper.
holdEventLoopUntilTestsFinish(test);

const { OllamaPullService } = require('../services/ollama-pull-service');

function fakeChild(pid = 7171) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  return child;
}

test('pull inactivity stops the owned process and resolves as a visible failure', async () => {
  const child = fakeChild();
  const service = new OllamaPullService({
    spawnImpl: () => child,
    requestIdProvider: () => 'inactive-pull',
    inactivityMs: 5,
    killProcessTreeImpl: async () => ({ terminated: true }),
  });

  const operation = service.start({ model: 'gemma3:latest' });
  const result = await operation.promise;

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'pull_inactivity');
  assert.equal(result.terminationConfirmed, true);
});

test('pull cancellation fails when process-tree termination cannot be confirmed', async () => {
  const child = fakeChild();
  const service = new OllamaPullService({
    spawnImpl: () => child,
    requestIdProvider: () => 'uncertain-pull',
    inactivityMs: 60_000,
    killProcessTreeImpl: async () => {
      child.emit('exit', 1);
      return { terminated: false };
    },
  });
  service.start({ model: 'gemma3:latest' });

  const result = await service.cancel({ requestId: 'uncertain-pull' });

  assert.equal(result.cancelled, false);
  assert.equal(result.termination_confirmed, false);
  assert.equal(result.code, 'termination_failed');
});

test('concurrent pull cancellations share one owned process-tree termination', async () => {
  const child = fakeChild();
  let kills = 0;
  let releaseKill;
  const service = new OllamaPullService({
    spawnImpl: () => child,
    requestIdProvider: () => 'shared-cancel',
    inactivityMs: 60_000,
    killProcessTreeImpl: async () => {
      kills += 1;
      await new Promise((resolve) => { releaseKill = resolve; });
      return { terminated: true };
    },
  });
  service.start({ model: 'gemma3:latest' });

  const first = service.cancel({ requestId: 'shared-cancel' });
  const second = service.cancel({ requestId: 'shared-cancel' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(kills, 1);
  releaseKill();
  const results = await Promise.all([first, second]);
  assert.equal(results[0].cancelled, true);
  assert.equal(results[1].cancelled, true);
});

test('pull progress parses lines fragmented across stream chunks', async () => {
  const child = fakeChild();
  const service = new OllamaPullService({
    spawnImpl: () => child,
    requestIdProvider: () => 'fragmented',
    inactivityMs: 60_000,
  });
  const operation = service.start({ model: 'gemma3:latest' });
  child.stderr.emit('data', 'pulling abc 5');
  child.stderr.emit('data', '0% 10 MB/20 MB\r');
  child.emit('exit', 0);
  const result = await operation.promise;

  assert.equal(result.status, 'completed');
  assert.equal(result.percent, 100);
});

test('delete settles as deleted when ollama rm exits before the deadline', async () => {
  const child = fakeChild();
  let kills = 0;
  const service = new OllamaPullService({
    spawnImpl: () => child,
    deleteTimeoutMs: 60_000,
    killProcessTreeImpl: async () => { kills += 1; return { terminated: true }; },
  });
  const pending = service.delete({ model: 'gemma3:latest' });
  child.emit('exit', 0);

  assert.deepEqual(await pending, { status: 'deleted', model: 'gemma3:latest' });
  assert.equal(kills, 0);
});

test('delete times out a stalled ollama rm, kills the process tree and ignores a later exit', async () => {
  const child = fakeChild(8282);
  const kills = [];
  const service = new OllamaPullService({
    spawnImpl: () => child,
    deleteTimeoutMs: 5,
    killProcessTreeImpl: async (pid, options) => {
      kills.push({ pid, options });
      // The child reporting success while the kill is in flight must not turn the timeout into a deletion.
      child.emit('exit', 0);
      return { terminated: true };
    },
  });

  const result = await service.delete({ model: 'gemma3:latest' });
  child.emit('exit', 0);

  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'delete_timeout');
  assert.equal(result.terminationConfirmed, true);
  assert.match(result.message, /timed out/i);
  assert.equal(kills.length, 1);
  assert.equal(kills[0].pid, 8282);
  assert.equal(kills[0].options.force, true);
  assert.equal(kills[0].options.confirmExit, true);
});

test('delete timeout reports unconfirmed termination when the kill fails', async () => {
  const child = fakeChild();
  const service = new OllamaPullService({
    spawnImpl: () => child,
    deleteTimeoutMs: 5,
    killProcessTreeImpl: async () => { throw new Error('kill failed'); },
  });

  const result = await service.delete({ model: 'gemma3:latest' });

  assert.equal(result.code, 'delete_timeout');
  assert.equal(result.terminationConfirmed, false);
});
