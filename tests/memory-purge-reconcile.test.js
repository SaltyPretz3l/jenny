'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startMemoryPurgeReconcile } = require('../services/backend/memory-purge-reconcile');

function harness(summaries = [{ id: 'present', archived_at: 'yesterday' }], ids = ['present', 'gone']) {
  const timers = new Set();
  const calls = [];
  const logs = [];
  const service = { sessionStore: { listSessions: () => summaries },
    _emitServiceLog: (...args) => logs.push(args),
    sidecarClient: { connected: true, async request(method, params) {
      calls.push({ method, params });
      if (method === 'memory.chat_sessions') return { session_ids: ids, truncated: false };
      return { removed: 1 };
    } } };
  const control = startMemoryPurgeReconcile({ service,
    setTimer(fn, ms) { assert.equal(ms, 15000); const timer = { fn, unref() {} }; timers.add(timer); return timer; },
    clearTimer: timer => timers.delete(timer) });
  const tick = async () => { const pending = [...timers]; timers.clear(); for (const timer of pending) await timer.fn(); };
  return { service, calls, logs, control, timers, tick, purges: () => calls.filter(c => c.method === 'memory.purge_session') };
}

test('waits for sidecar ready, preserves archived/indexed chats and runs once', async () => {
  const h = harness(); h.service.sidecarClient.connected = false;
  await h.tick(); assert.equal(h.calls.length, 0); assert.equal(h.timers.size, 1);
  h.service.sidecarClient.connected = true;
  h.service.sidecarManager = { getStatus: () => ({ phase: 'starting' }) };
  await h.tick(); assert.equal(h.calls.length, 0);
  h.service.sidecarManager.getStatus = () => ({ phase: 'ready' });
  await h.tick(); assert.deepEqual(h.purges().map(c => c.params.session_id), ['gone']);
  assert.equal(h.calls[0].params.limit, 2000);
  await h.tick(); assert.equal(h.purges().length, 1); assert.equal(h.timers.size, 0);
});

test('empty or failed index never purges and is not retried', async () => {
  for (const throws of [false, true]) {
    const h = harness([]);
    if (throws) h.service.sessionStore.listSessions = () => { throw new Error('private text'); };
    await h.tick(); await h.tick(); assert.equal(h.purges().length, 0); assert.equal(h.timers.size, 0);
    assert.equal(JSON.stringify(h.logs).includes('private text'), false);
  }
});

test('purges sequentially, at most 50 unique missing ids per launch', async () => {
  const h = harness(undefined, ['gone', 'gone', ...Array.from({ length: 60 }, (_, i) => 'gone' + i)]);
  let active = false;
  const request = h.service.sidecarClient.request;
  h.service.sidecarClient.request = async (method, params) => {
    if (method !== 'memory.purge_session') return request(method, params);
    assert.equal(active, false); active = true; await Promise.resolve();
    const result = await request(method, params); active = false; return result;
  };
  await h.tick(); assert.equal(h.purges().length, 50);
  assert.equal(new Set(h.purges().map(c => c.params.session_id)).size, 50);
});

test('request failure stops the pass quietly; dispose stops polling or an active pass', async () => {
  const h = harness();
  h.service.sidecarClient.request = async () => { throw new Error('private text'); };
  await h.tick(); assert.equal(h.timers.size, 0); assert.equal(JSON.stringify(h.logs).includes('private text'), false);
  const stopped = harness(); stopped.control.dispose(); await stopped.tick(); assert.equal(stopped.calls.length, 0);
  const active = harness(undefined, ['gone', 'later']);
  const request = active.service.sidecarClient.request;
  active.service.sidecarClient.request = async (method, params) => {
    const answer = await request(method, params);
    if (method === 'memory.purge_session') active.control.dispose();
    return answer;
  };
  await active.tick(); assert.equal(active.purges().length, 1);
});


test('a logging failure cannot reject the one-shot pass', async () => {
  const h = harness();
  h.service.sidecarClient.request = async () => { throw new Error('sidecar unavailable'); };
  h.service._emitServiceLog = () => { throw new Error('logger unavailable'); };
  await assert.doesNotReject(h.tick());
  assert.equal(h.timers.size, 0);
});
