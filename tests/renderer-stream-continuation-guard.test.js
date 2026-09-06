const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createStreamContinuationOwner,
} = require('../renderer/chat/renderer-stream-continuation-guard');

function createOwner(state, overrides = {}) {
  return createStreamContinuationOwner({
    state,
    normalizeId: (value) => String(value || '').trim(),
    ...overrides,
  });
}

test('message update continuation rejects a replaced session incarnation', () => {
  const state = {
    sessions: [{ id: 'session_1', session_incarnation: 'inc_1' }],
    messagesBySession: new Map([['session_1', []]]),
  };
  const owner = createOwner(state);
  const update = owner.beginMessageUpdate('session_1', 'message_1');
  state.sessions = [{ id: 'session_1', session_incarnation: 'inc_2' }];
  assert.equal(update.isCurrent(), false);
  update.finish();
});

test('newer message update revision supersedes an older fetch', () => {
  const state = { sessions: [], messagesBySession: new Map([['session_1', []]]) };
  const owner = createOwner(state);
  const older = owner.beginMessageUpdate('session_1', 'message_1');
  const newer = owner.beginMessageUpdate('session_1', 'message_1');
  assert.equal(older.isCurrent(), false);
  assert.equal(newer.isCurrent(), true);
  older.finish();
  assert.equal(newer.isCurrent(), true, 'older cleanup cannot delete the newer revision');
  newer.finish();
});

test('terminal continuation combines renderer epoch, postwork, and stream generation fences', () => {
  let epochCurrent = true;
  let postworkCurrent = true;
  let generationCurrent = true;
  const owner = createOwner({ sessions: [], messagesBySession: new Map() }, {
    captureStreamGeneration: () => ({ generation: 2 }),
    isStreamGenerationCurrent: () => generationCurrent,
    isPostworkContinuationValid: () => postworkCurrent,
  });
  const guard = owner.createTerminalContinuation(
    { sessionId: 'session_1', streamId: 'stream_2' },
    { continuationGuard: { isCurrent: () => epochCurrent } },
    4
  );
  assert.equal(guard.isCurrent(), true);
  epochCurrent = false;
  assert.equal(guard.isCurrent(), false);
  epochCurrent = true;
  postworkCurrent = false;
  assert.equal(guard.isCurrent(), false);
  postworkCurrent = true;
  generationCurrent = false;
  assert.equal(guard.isCurrent(), false);
});
