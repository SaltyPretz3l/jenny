const test = require('node:test');
const assert = require('node:assert/strict');

const { createStreamMailbox } = require('../renderer/chat/renderer-stream-mailbox');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('stream mailbox serializes one stream while independent streams remain parallel', async () => {
  const mailbox = createStreamMailbox();
  const firstGate = deferred();
  const calls = [];

  const first = mailbox.enqueue({ streamId: 'stream-a' }, async () => {
    calls.push('a:start');
    await firstGate.promise;
    calls.push('a:end');
  });
  const second = mailbox.enqueue({ streamId: 'stream-a' }, async () => {
    calls.push('a:second');
  });
  const parallel = mailbox.enqueue({ streamId: 'stream-b' }, async () => {
    calls.push('b:parallel');
  });

  await parallel;
  assert.deepEqual(calls, ['a:start', 'b:parallel']);
  firstGate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ['a:start', 'b:parallel', 'a:end', 'a:second']);
});

test('dispose aborts in-flight work and prevents guarded late mutations', async () => {
  const mailbox = createStreamMailbox();
  const gate = deferred();
  const mutations = [];

  const running = mailbox.enqueue({ streamId: 'stream-a' }, async ({ signal, guard }) => {
    await gate.promise;
    assert.equal(signal.aborted, true);
    guard.mutate(() => mutations.push('late'));
  });

  mailbox.dispose();
  gate.resolve();
  await running;

  assert.deepEqual(mutations, []);
  assert.deepEqual(
    await mailbox.enqueue({ streamId: 'stream-a' }, async () => 'unexpected'),
    { dropped: true, reason: 'disposed' }
  );
});

test('beginEpoch invalidates suspended listeners from the prior subscription', async () => {
  const mailbox = createStreamMailbox();
  const gate = deferred();
  const mutations = [];

  const stale = mailbox.enqueue({ streamId: 'stream-a' }, async ({ guard }) => {
    await gate.promise;
    guard.mutate(() => mutations.push('stale'));
  });
  const nextEpoch = mailbox.beginEpoch();
  gate.resolve();
  await stale;

  await mailbox.enqueue({ streamId: 'stream-a' }, async ({ rendererEpoch, guard }) => {
    assert.equal(rendererEpoch, nextEpoch);
    guard.mutate(() => mutations.push('current'));
  });
  assert.deepEqual(mutations, ['current']);
});
