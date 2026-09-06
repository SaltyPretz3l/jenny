'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { abortAndDrainActiveStreams } = require('../services/backend/active-stream-shutdown-drain');

test('shutdown drain aborts and waits for active settlement before deleting registry entries', async () => {
  let settle;
  const controller = new AbortController();
  controller._pendingPromise = new Promise((resolve) => { settle = resolve; });
  const activeStreams = new Map([['stream-1', controller]]);
  const service = {
    activeStreams,
    _abortActiveStreams() { controller.abort(); },
    _emitServiceLog() {},
  };
  const draining = abortAndDrainActiveStreams(service, { timeoutMs: 1000 });
  assert.equal(controller.signal.aborted, true);
  assert.equal(activeStreams.has('stream-1'), true, 'entry remains until settlement');
  settle();
  const result = await draining;
  assert.equal(result.drained, true);
  assert.equal(activeStreams.size, 0);
});

test('shutdown drain reports timeout without discarding unresolved evidence', async () => {
  const controller = new AbortController();
  controller._pendingPromise = new Promise(() => {});
  const activeStreams = new Map([['stream-timeout', controller]]);
  const logs = [];
  const service = {
    activeStreams,
    _abortActiveStreams() { controller.abort(); },
    _emitServiceLog(level, event, details) { logs.push({ level, event, details }); },
  };
  const result = await abortAndDrainActiveStreams(service, { timeoutMs: 5 });
  assert.equal(result.timedOut, true);
  assert.equal(activeStreams.has('stream-timeout'), true);
  assert.equal(logs.at(-1).event, 'chat.active_stream_shutdown_drain');
});
