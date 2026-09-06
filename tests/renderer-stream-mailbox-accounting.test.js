const test = require('node:test');
const assert = require('node:assert/strict');

const { createStreamMailbox } = require('../renderer/chat/renderer-stream-mailbox');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function zeroStats() {
  return {
    depth: 0,
    peakDepth: 0,
    queuedBytes: 0,
    peakQueuedBytes: 0,
    dropped: 0,
  };
}

test('tracks queue-depth and queued-byte peaks without retaining drained keys', async () => {
  const mailbox = createStreamMailbox();
  const gate = deferred();
  const payloads = [
    { streamId: 'stream-depth', content: 'abc', aggregate: '12' },
    { streamId: 'stream-depth', content: 'four', aggregate: '567' },
    { streamId: 'stream-depth', content: 'z', aggregate: { ignored: true } },
  ];
  const pending = payloads.map((payload, index) => mailbox.enqueue(payload, async () => {
    await gate.promise;
    return index;
  }));

  assert.deepEqual(mailbox.getMailboxStats({ streamId: 'stream-depth' }), {
    depth: 3,
    peakDepth: 3,
    queuedBytes: 13,
    peakQueuedBytes: 13,
    dropped: 0,
  });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(mailbox.getMailboxStats('stream:stream-depth').depth, 2);
  gate.resolve();
  assert.deepEqual(await Promise.all(pending), [0, 1, 2]);
  assert.deepEqual(mailbox.getMailboxStats({ streamId: 'stream-depth' }), zeroStats());
});

test('counts reasoning-only text in queued-byte accounting', async () => {
  const mailbox = createStreamMailbox();
  const gate = deferred();
  const pending = mailbox.enqueue({
    streamId: 'stream-reasoning-bytes',
    reasoning: {
      entriesDelta: [{ text: 'alpha' }, { text: 'beta' }, { text: 123 }],
      delta: 'gamma',
    },
  }, async () => gate.promise);

  assert.deepEqual(mailbox.getMailboxStats({ streamId: 'stream-reasoning-bytes' }), {
    depth: 1,
    peakDepth: 1,
    queuedBytes: 14,
    peakQueuedBytes: 14,
    dropped: 0,
  });
  gate.resolve('done');
  assert.equal(await pending, 'done');
});

test('counts reasoning append edits in queued-byte accounting', async () => {
  const mailbox = createStreamMailbox();
  const gate = deferred();
  const pending = mailbox.enqueue({
    streamId: 'stream-reasoning-edit-bytes',
    reasoning: {
      entriesDelta: [{ id: 'r1', baseLength: 3, baseTail: 'abc', append: 'delta' }],
    },
  }, async () => gate.promise);

  assert.equal(
    mailbox.getMailboxStats({ streamId: 'stream-reasoning-edit-bytes' }).queuedBytes,
    5
  );
  gate.resolve('done');
  assert.equal(await pending, 'done');
});

test('counts stale drops while beginEpoch releases the key accounting', async (t) => {
  const mailbox = createStreamMailbox();
  const reports = [];
  const originalMetricsModule = globalThis.rendererStreamClientMetricsModule;
  globalThis.rendererStreamClientMetricsModule = {
    getShared: () => ({ noteMailbox: (...args) => reports.push(args) }),
  };
  t.after(() => { globalThis.rendererStreamClientMetricsModule = originalMetricsModule; });

  const pending = Array.from({ length: 3 }, () => (
    mailbox.enqueue({ streamId: 'stream-stale' }, async () => 'unexpected')
  ));
  mailbox.beginEpoch();
  assert.deepEqual(mailbox.getMailboxStats({ streamId: 'stream-stale' }), zeroStats());
  const settled = await Promise.all(pending);

  assert.deepEqual(settled, [
    { dropped: true, reason: 'aborted' },
    { dropped: true, reason: 'aborted' },
    { dropped: true, reason: 'aborted' },
  ]);
  assert.equal(Math.max(...reports.map(([, , stats]) => stats.dropped)), 3);
  assert.deepEqual(mailbox.getMailboxStats({ streamId: 'stream-stale' }), zeroStats());
});

test('releases accounting after key drain, beginEpoch, and dispose', async () => {
  const mailbox = createStreamMailbox();

  await mailbox.enqueue({ streamId: 'stream-drain', content: 'x' }, async () => 'done');
  assert.deepEqual(mailbox.getMailboxStats({ streamId: 'stream-drain' }), zeroStats());

  const stale = mailbox.enqueue({ streamId: 'stream-epoch', content: 'xx' }, async () => 'stale');
  mailbox.beginEpoch();
  assert.deepEqual(mailbox.getMailboxStats({ streamId: 'stream-epoch' }), zeroStats());
  await stale;

  const disposed = mailbox.enqueue({ streamId: 'stream-dispose', content: 'xxx' }, async () => 'stale');
  mailbox.dispose();
  assert.deepEqual(mailbox.getMailboxStats({ streamId: 'stream-dispose' }), zeroStats());
  await disposed;
});

test('preserves per-key ordering and enqueue resolution behavior', async () => {
  const mailbox = createStreamMailbox();
  const gate = deferred();
  const calls = [];
  const first = mailbox.enqueue({ streamId: 'stream-order' }, async () => {
    calls.push('first:start');
    await gate.promise;
    calls.push('first:end');
    return { value: 'normal' };
  });
  const second = mailbox.enqueue({ streamId: 'stream-order' }, async () => {
    calls.push('second');
    return 'second-value';
  });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.deepEqual(calls, ['first:start']);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [{ value: 'normal' }, 'second-value']);
  assert.deepEqual(calls, ['first:start', 'first:end', 'second']);

  const dropped = mailbox.enqueue({ streamId: 'stream-drop-shape' }, async () => 'unexpected');
  mailbox.beginEpoch();
  assert.deepEqual(await dropped, { dropped: true, reason: 'aborted' });

  const expectedError = new Error('task failed');
  const rejected = mailbox.enqueue({ streamId: 'stream-reject' }, async () => {
    throw expectedError;
  });
  await assert.rejects(rejected, (error) => error === expectedError);
});

test('throwing diagnostics lookup never breaks delivery', async (t) => {
  const originalMetricsModule = globalThis.rendererStreamClientMetricsModule;
  globalThis.rendererStreamClientMetricsModule = {
    getShared() {
      throw new Error('metrics unavailable');
    },
  };
  t.after(() => { globalThis.rendererStreamClientMetricsModule = originalMetricsModule; });

  const mailbox = createStreamMailbox();
  assert.equal(
    await mailbox.enqueue({ streamId: 'stream-safe' }, async () => 'delivered'),
    'delivered',
  );
});

test('session-only payloads are counted internally but never reported', async (t) => {
  let getSharedCalls = 0;
  let noteMailboxCalls = 0;
  const originalMetricsModule = globalThis.rendererStreamClientMetricsModule;
  globalThis.rendererStreamClientMetricsModule = {
    getShared() {
      getSharedCalls += 1;
      return { noteMailbox: () => { noteMailboxCalls += 1; } };
    },
  };
  t.after(() => { globalThis.rendererStreamClientMetricsModule = originalMetricsModule; });

  const mailbox = createStreamMailbox();
  const gate = deferred();
  const pending = mailbox.enqueue(
    { sessionId: 'session-only', content: '1234' },
    async () => gate.promise,
  );
  assert.deepEqual(mailbox.getMailboxStats({ sessionId: 'session-only' }), {
    depth: 1,
    peakDepth: 1,
    queuedBytes: 4,
    peakQueuedBytes: 4,
    dropped: 0,
  });
  assert.equal(getSharedCalls, 0);
  assert.equal(noteMailboxCalls, 0);
  gate.resolve('done');
  assert.equal(await pending, 'done');
});
