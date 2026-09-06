const { test } = require('node:test');
const assert = require('node:assert');

const { createClientLogForwarder } = require('../renderer/shell/renderer-log-forwarder');
const { createClientLogBatchHandler } = require('../services/main/client-log-forwarding');

function createManualTimers() {
  const pending = new Map();
  let nextHandle = 1;
  return {
    setTimeoutFn(fn, _delay) {
      const handle = nextHandle++;
      pending.set(handle, fn);
      return handle;
    },
    clearTimeoutFn(handle) {
      pending.delete(handle);
    },
    fire() {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const fn of callbacks) fn();
    },
    pendingCount() {
      return pending.size;
    },
  };
}

test('forwarder batches renderer entries and flushes on timer', () => {
  const timers = createManualTimers();
  const batches = [];
  const forwarder = createClientLogForwarder({
    sendBatch: (batch) => batches.push(batch),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  forwarder.enqueue({ source: 'renderer', level: 'INFO', event: 'a' });
  forwarder.enqueue({ source: 'renderer', level: 'WARN', event: 'b' });
  assert.strictEqual(batches.length, 0);
  timers.fire();
  assert.strictEqual(batches.length, 1);
  assert.strictEqual(batches[0].entries.length, 2);
  assert.strictEqual(batches[0].dropped_count, 0);
});

test('forwarder ignores electron-sourced entries and gates DEBUG on the flag', () => {
  const timers = createManualTimers();
  const batches = [];
  let debugEnabled = false;
  const forwarder = createClientLogForwarder({
    sendBatch: (batch) => batches.push(batch),
    isDebugForwardingEnabled: () => debugEnabled,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  forwarder.enqueue({ source: 'electron', level: 'INFO', event: 'main-side' });
  forwarder.enqueue({ source: 'renderer', level: 'DEBUG', event: 'noisy' });
  timers.fire();
  assert.strictEqual(batches.length, 0);

  debugEnabled = true;
  forwarder.enqueue({ source: 'renderer', level: 'DEBUG', event: 'wanted' });
  timers.fire();
  assert.strictEqual(batches.length, 1);
  assert.strictEqual(batches[0].entries[0].event, 'wanted');
});

test('forwarder flushes eagerly at max batch size and caps the buffer', () => {
  const timers = createManualTimers();
  const batches = [];
  const forwarder = createClientLogForwarder({
    sendBatch: (batch) => batches.push(batch),
    maxBatchSize: 3,
    maxBufferSize: 2,
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  forwarder.enqueue({ source: 'renderer', level: 'INFO', event: 'one' });
  forwarder.enqueue({ source: 'renderer', level: 'INFO', event: 'two' });
  forwarder.enqueue({ source: 'renderer', level: 'INFO', event: 'three' });
  // Buffer capped at 2 → 'one' dropped, then batch-size flush never reached 3.
  timers.fire();
  assert.strictEqual(batches.length, 1);
  assert.deepStrictEqual(batches[0].entries.map((entry) => entry.event), ['two', 'three']);
  assert.strictEqual(batches[0].dropped_count, 1);
});

test('forwarder dispose flushes pending entries and stops accepting new ones', () => {
  const timers = createManualTimers();
  const batches = [];
  const forwarder = createClientLogForwarder({
    sendBatch: (batch) => batches.push(batch),
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  forwarder.enqueue({ source: 'renderer', level: 'INFO', event: 'pending' });
  forwarder.dispose();
  assert.strictEqual(batches.length, 1);
  assert.strictEqual(timers.pendingCount(), 0);
  forwarder.enqueue({ source: 'renderer', level: 'INFO', event: 'late' });
  timers.fire();
  assert.strictEqual(batches.length, 1);
});

test('forwarder send failures never throw out of enqueue/flush', () => {
  const timers = createManualTimers();
  const successBatches = [];
  let shouldThrow = true;
  const forwarder = createClientLogForwarder({
    sendBatch: (batch) => {
      if (shouldThrow) throw new Error('bridge gone');
      successBatches.push(batch);
    },
    setTimeoutFn: timers.setTimeoutFn,
    clearTimeoutFn: timers.clearTimeoutFn,
  });
  forwarder.enqueue({ source: 'renderer', level: 'INFO', event: 'x' });
  assert.doesNotThrow(() => timers.fire());
  // After a failed send the buffer is cleared (reset happens before sendBatch);
  // a new entry enqueued after recovery should be the sole entry in the next batch.
  shouldThrow = false;
  forwarder.enqueue({ source: 'renderer', level: 'INFO', event: 'after-recovery' });
  timers.fire();
  assert.strictEqual(successBatches.length, 1);
  assert.strictEqual(successBatches[0].entries.length, 1);
  assert.strictEqual(successBatches[0].entries[0].event, 'after-recovery');
});

test('main batch handler writes normalized renderer entries to the process log writer', () => {
  const written = [];
  const handler = createClientLogBatchHandler({
    getProcessLogWriter: () => ({ write: (entry) => written.push(entry) }),
    env: {},
  });
  handler(null, {
    entries: [
      { source: 'renderer', layer: 'renderer', level: 'INFO', event: 'chat.send', message: 'ok' },
      null,
      { source: 'renderer', layer: 'electron', level: 'WARN', event: 'spoof.attempt' },
    ],
    dropped_count: 0,
  });
  assert.strictEqual(written.length, 2);
  assert.strictEqual(written[0].layer, 'renderer');
  assert.strictEqual(written[0].event, 'chat.send');
  // Layer/source are pinned server-side; a crafted layer cannot impersonate electron.
  assert.strictEqual(written[1].layer, 'renderer');
  assert.strictEqual(written[1].source, 'renderer');
});

test('main batch handler drops DEBUG entries unless agent mode enables them', () => {
  const written = [];
  const makeHandler = (env) => createClientLogBatchHandler({
    getProcessLogWriter: () => ({ write: (entry) => written.push(entry) }),
    env,
  });
  makeHandler({})(null, {
    entries: [{ source: 'renderer', level: 'DEBUG', event: 'noisy' }],
  });
  assert.strictEqual(written.length, 0);
  makeHandler({ JENNY_AGENT_DEV: '1' })(null, {
    entries: [{ source: 'renderer', level: 'DEBUG', event: 'wanted' }],
  });
  assert.strictEqual(written.length, 1);
  assert.strictEqual(written[0].level, 'DEBUG');
});

test('main batch handler isolates malformed entries and missing writer', () => {
  const handler = createClientLogBatchHandler({
    getProcessLogWriter: () => null,
    env: {},
  });
  assert.doesNotThrow(() => handler(null, { entries: [{ level: 'INFO' }] }));
  const written = [];
  const writingHandler = createClientLogBatchHandler({
    getProcessLogWriter: () => ({ write: (entry) => written.push(entry) }),
    env: {},
  });
  assert.doesNotThrow(() => writingHandler(null, 'not-a-batch'));
  assert.doesNotThrow(() => writingHandler(null, { entries: 'nope' }));
  assert.strictEqual(written.length, 0);
});
