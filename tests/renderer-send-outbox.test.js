const test = require('node:test');
const assert = require('node:assert/strict');

const { createSendOutbox } = require('../renderer/chat/renderer-send-outbox');

function state() { return { queuedSendBySession: new Map(), sendOutboxBySession: new Map() }; }

test('multiple sends preserve immutable FIFO order', () => {
  const store = state();
  const outbox = createSendOutbox(store);
  const first = outbox.enqueue('s1', { prompt: 'first', status: 'ready' });
  const second = outbox.enqueue('s1', { prompt: 'second', status: 'ready' });
  assert.deepEqual(outbox.list('s1').map((entry) => entry.prompt), ['first', 'second']);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(outbox.remove(second), true);
  assert.equal(outbox.peek('s1').id, first.id, 'removing a later exact item cannot disturb the head');
});

test('exact item revision is required for transitions and clearing', () => {
  const outbox = createSendOutbox(state());
  const original = outbox.enqueue('s1', { prompt: 'draft', status: 'ready' });
  const edited = outbox.edit(original, 'edited');
  assert.equal(outbox.remove(original), false, 'stale revision cannot clear the edited item');
  assert.equal(outbox.peek('s1').prompt, 'edited');
  assert.equal(outbox.remove(edited), true);
});

test('blank edits stay in review unless a prompt-bearing attachment remains', () => {
  const outbox = createSendOutbox(state());
  const textOnly = outbox.enqueue('s1', { prompt: 'draft', status: 'needs_review' });
  const attachmentOnly = outbox.enqueue('s1', {
    prompt: 'describe this',
    status: 'needs_review',
    attachments: [{ id: 'image-1', kind: 'image' }],
  });

  const blankTextOnly = outbox.edit(textOnly, '   ');
  const blankWithAttachment = outbox.edit(attachmentOnly, '');

  assert.equal(blankTextOnly.prompt, '   ');
  assert.equal(blankTextOnly.status, 'needs_review');
  assert.equal(blankWithAttachment.status, 'ready');
});

test('context capture settles before dispatch or records an explicit omission', async () => {
  const timers = [];
  const outbox = createSendOutbox(state(), {
    setTimeoutImpl: (callback) => { timers.push(callback); return timers.length; },
    clearTimeoutImpl: () => {},
  });
  const captured = outbox.enqueue('s1', { prompt: 'captured' });
  const captureDone = outbox.settleContextCapture(captured, Promise.resolve({ mentionContentsSnapshot: [{ path: 'a.js' }] }));
  const ready = await outbox.awaitContextCapture(captured);
  await captureDone;
  assert.equal(ready.status, 'ready');
  assert.equal(ready.meta.mentionContentsSnapshot[0].path, 'a.js');

  const omitted = outbox.enqueue('s1', { prompt: 'omitted' });
  const omittedDone = outbox.settleContextCapture(omitted, new Promise(() => {}));
  timers.at(-1)();
  await omittedDone;
  assert.equal(outbox.list('s1')[1].meta.contextOmission.reason, 'context_capture_timeout');
});

test('legacy one-slot state migrates into the FIFO head without loss', () => {
  const store = state();
  const released = [];
  store.queuedSendBySession.set('s1', {
    sessionId: 's1', prompt: 'legacy', attachments: [{ assetPath: 'legacy-asset' }],
  });
  const outbox = createSendOutbox(store, { releaseAssets: (paths) => released.push(paths) });
  assert.equal(outbox.peek('s1').prompt, 'legacy');
  assert.equal(outbox.list('s1').length, 1);
  outbox.clearSession('s1');
  assert.deepEqual(released, [['legacy-asset']]);
});

test('capture failure is explicit and survives a session rekey by item identity', async () => {
  const store = state();
  const outbox = createSendOutbox(store);
  const entry = outbox.enqueue('local', { prompt: 'move me' });
  const settled = outbox.settleContextCapture(entry, Promise.reject(new Error('read failed')));
  outbox.rekeySession('local', 'persisted');
  await settled;

  assert.equal(outbox.list('local').length, 0);
  assert.equal(outbox.list('persisted').length, 1);
  assert.equal(outbox.peek('persisted').meta.contextOmission.reason, 'context_capture_failed');
  outbox.clearAll();
  assert.equal(store.sendOutboxBySession.size, 0);
  assert.equal(store.queuedSendBySession.size, 0);
});

test('bounds normalize malformed limits and rekey never drops existing items', () => {
  const store = state();
  const outbox = createSendOutbox(store, { maxItems: 1.9 });
  const source = outbox.enqueue('source', { prompt: 'source', status: 'ready' });
  const target = outbox.enqueue('target', { prompt: 'target', status: 'ready' });
  assert.ok(source);
  assert.ok(target);
  assert.equal(outbox.enqueue('source', { prompt: 'overflow', status: 'ready' }), null);
  outbox.rekeySession('source', 'target');
  assert.deepEqual(outbox.list('target').map((entry) => entry.prompt), ['target', 'source']);
});

test('queued attachment ownership releases exactly once on cancel or clear', () => {
  const released = [];
  const outbox = createSendOutbox(state(), { releaseAssets: (paths) => released.push(paths) });
  const canceled = outbox.enqueue('s1', { prompt: 'cancel', status: 'ready', attachments: [{ assetPath: 'asset-a' }] });
  outbox.enqueue('s2', { prompt: 'clear', status: 'ready', attachments: [{ assetPath: 'asset-b' }] });
  assert.equal(outbox.remove(canceled), true);
  outbox.clearAll();
  outbox.clearAll();
  assert.deepEqual(released.flat().sort(), ['asset-a', 'asset-b']);
});

test('sending entries transfer attachment ownership to the send receipt', () => {
  const released = [];
  const outbox = createSendOutbox(state(), { releaseAssets: (paths) => released.push(paths) });
  const queued = outbox.enqueue('s1', { prompt: 'send', status: 'ready', attachments: [{ assetPath: 'asset-a' }] });
  const sending = outbox.replace(queued, { status: 'sending', attachmentOwner: 'send_receipt' });
  outbox.remove(sending);
  assert.deepEqual(released, []);
});

test('separate queue entries can each own and release a reused asset path', () => {
  const released = [];
  const outbox = createSendOutbox(state(), { releaseAssets: (paths) => released.push(paths) });
  const first = outbox.enqueue('s1', { prompt: 'first', status: 'ready', attachments: [{ assetPath: 'asset-a' }] });
  assert.equal(outbox.remove(first), true);
  const second = outbox.enqueue('s1', { prompt: 'second', status: 'ready', attachments: [{ assetPath: 'asset-a' }] });
  assert.equal(outbox.remove(second), true);
  assert.deepEqual(released, [['asset-a'], ['asset-a']]);
});
