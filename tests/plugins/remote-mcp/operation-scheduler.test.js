'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { RemoteMcpScheduler } = require('../../../services/plugins/remote-mcp/operation-scheduler');

function deferred() {
  let resolve; const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('scheduler enforces global/per-descriptor concurrency and queue bounds', async () => {
  const gate = deferred();
  const scheduler = new RemoteMcpScheduler({ global_inflight: 1, descriptor_inflight: 1,
    global_queue: 1, descriptor_queue: 1 });
  const first = scheduler.submit('a', async () => { await gate.promise; return { ok: true, id: 1 }; });
  const second = scheduler.submit('a', async () => ({ ok: true, id: 2 }));
  assert.equal((await scheduler.submit('a', async () => ({ ok: true }))).reason,
    'remote_queue_limit_exceeded');
  gate.resolve();
  assert.equal((await first).id, 1);
  assert.equal((await second).id, 2);
  assert.deepEqual(scheduler.snapshot(), { active: 0, queued: 0 });
});

test('queued and active cancellation settle once and dispose drains state', async () => {
  const gate = deferred();
  const scheduler = new RemoteMcpScheduler({ global_inflight: 1, descriptor_inflight: 1,
    global_queue: 4, descriptor_queue: 4 });
  const active = scheduler.submit('a', async (signal) => {
    await gate.promise; return { ok: !signal.aborted };
  });
  const controller = new AbortController();
  const queued = scheduler.submit('a', async () => ({ ok: true }), { signal: controller.signal });
  controller.abort();
  assert.equal((await queued).reason, 'operation_cancelled');
  scheduler.dispose(); gate.resolve();
  assert.equal((await active).reason, 'operation_cancelled');
});
