const test = require('node:test');
const assert = require('node:assert/strict');

const { createMultiStreamController } = require('../renderer/chat/renderer-multi-stream-utils');

test('multi-stream controller tracks concurrent streams by session', () => {
  const state = { pendingToolApprovals: new Map() };
  const controller = createMultiStreamController({ getState: () => state, appendClientLog() {} });

  controller.registerStream('session-1', 'stream-1');
  controller.registerStream('session-2', 'stream-2');

  assert.equal(controller.isSessionStreaming('session-1'), true);
  assert.equal(controller.getStreamIdForSession('session-2'), 'stream-2');
  assert.equal(controller.getSessionIdForStream('stream-1'), 'session-1');
  assert.deepEqual(controller.getStreamingSessionIds().sort(), ['session-1', 'session-2']);

  controller.clearStream('stream-1');
  assert.equal(controller.isSessionStreaming('session-1'), false);
  assert.deepEqual(controller.getStreamingSessionIds(), ['session-2']);

  controller.clearSessionStream('session-2');
  assert.equal(controller.getStreamingSessionIds().length, 0);
});

test('multi-stream controller manages preflight lifecycle and cancel targeting', () => {
  const controller = createMultiStreamController({ getState: () => ({ pendingToolApprovals: new Map() }), appendClientLog() {} });
  const preflight = { pending: true, streamId: '', sessionId: 'session-1' };

  controller.registerPreflight('session-1', preflight);
  assert.equal(controller.isSessionInPreflight('session-1'), true);
  assert.equal(controller.isAnySendBusy(), true);

  preflight.pending = false;
  assert.equal(controller.isSessionInPreflight('session-1'), false);
  assert.equal(controller.isAnySendBusy(), false);

  preflight.pending = true;
  assert.equal(controller.isSessionInPreflight('session-1'), true);
  assert.equal(controller.isAnySendBusy(), true);

  controller.registerStream('session-1', 'stream-1');
  assert.equal(controller.getActiveStreamIdForCancel('session-1'), 'stream-1');

  controller.clearPreflight('session-1');
  assert.equal(controller.isSessionInPreflight('session-1'), false);
  assert.equal(controller.isAnySendBusy(), true);

  controller.clearStream('stream-1');
  assert.equal(controller.isAnySendBusy(), false);
});

test('multi-stream controller tracks the terminal post-work window as send-busy', () => {
  const controller = createMultiStreamController({ getState: () => ({ pendingToolApprovals: new Map() }), appendClientLog() {} });

  // Idle session: not busy.
  assert.equal(controller.isSessionInTerminalPostwork('session-1'), false);
  assert.equal(controller.isSessionSendBusy('session-1'), false);
  assert.equal(controller.isAnySendBusy(), false);

  // Post-work window: the stream is already cleared and the lifecycle reset to
  // idle, yet the session must still be send-busy so a follow-up send queues.
  assert.equal(controller.beginTerminalPostworkGeneration('session-1'), 1);
  assert.equal(controller.isSessionInTerminalPostwork('session-1'), true);
  assert.equal(controller.isSessionStreaming('session-1'), false);
  assert.equal(controller.isSessionInPreflight('session-1'), false);
  assert.equal(controller.isSessionSendBusy('session-1'), true);
  assert.equal(controller.isAnySendBusy(), true);

  // Guard is per-session.
  assert.equal(controller.isSessionSendBusy('session-2'), false);

  // Clearing releases the guard (no permanent-busy leak).
  assert.equal(controller.clearTerminalPostwork('session-1'), true);
  assert.equal(controller.isSessionInTerminalPostwork('session-1'), false);
  assert.equal(controller.isSessionSendBusy('session-1'), false);
  assert.equal(controller.isAnySendBusy(), false);

  // dispose clears any lingering post-work guard.
  controller.beginTerminalPostworkGeneration('session-3');
  controller.dispose();
  assert.equal(controller.isSessionInTerminalPostwork('session-3'), false);
  assert.equal(controller.isAnySendBusy(), false);
});

test('multi-stream controller isSessionSendBusy folds streaming, preflight, and post-work', () => {
  const controller = createMultiStreamController({ getState: () => ({ pendingToolApprovals: new Map() }), appendClientLog() {} });

  controller.registerStream('streaming-session', 'stream-x');
  assert.equal(controller.isSessionSendBusy('streaming-session'), true);

  controller.registerPreflight('preflight-session', { pending: true, sessionId: 'preflight-session' });
  assert.equal(controller.isSessionSendBusy('preflight-session'), true);

  controller.beginTerminalPostworkGeneration('postwork-session');
  assert.equal(controller.isSessionSendBusy('postwork-session'), true);

  assert.equal(controller.isSessionSendBusy('idle-session'), false);
  assert.equal(controller.isSessionSendBusy(''), false);
});

test('multi-stream controller finalizes a stream on clearStream and refuses re-registration', () => {
  const controller = createMultiStreamController({ getState: () => ({ pendingToolApprovals: new Map() }), appendClientLog() {} });

  controller.registerStream('session-1', 'stream-1');
  assert.equal(controller.isStreamFinalized('stream-1'), false);
  assert.equal(controller.isSessionSendBusy('session-1'), true);

  // Terminal cleanup goes through clearStream, which records the terminal.
  controller.clearStream('stream-1');
  assert.equal(controller.isStreamFinalized('stream-1'), true);
  assert.equal(controller.isSessionStreaming('session-1'), false);
  assert.equal(controller.isSessionSendBusy('session-1'), false);

  // A late/duplicate `started` for the finalized stream must not resurrect it.
  assert.equal(controller.registerStream('session-1', 'stream-1'), null);
  assert.equal(controller.isSessionStreaming('session-1'), false);
  assert.equal(controller.isSessionSendBusy('session-1'), false);
  assert.deepEqual(controller.getStreamingSessionIds(), []);

  // A genuinely new stream id is unaffected.
  assert.equal(controller.registerStream('session-1', 'stream-2'), 'stream-2');
  assert.equal(controller.isSessionStreaming('session-1'), true);
});

test('multi-stream controller transfers stream generation ownership during session rekey', () => {
  // The optimistic→canonical session rekey clears the source session and
  // re-registers the SAME (still mid-flight) stream under the canonical id.
  // clearSessionStream must therefore never mark the stream finalized.
  const controller = createMultiStreamController({ getState: () => ({ pendingToolApprovals: new Map() }), appendClientLog() {} });

  controller.registerStream('optimistic-session', 'stream-1');
  const sourceToken = controller.captureStreamGeneration('optimistic-session', 'stream-1');
  const clearedStreamId = controller.rekeySessionStream('optimistic-session', 'canonical-session');

  assert.equal(clearedStreamId, 'stream-1');
  assert.equal(controller.isStreamFinalized('stream-1'), false);
  assert.equal(controller.isSessionStreaming('canonical-session'), true);
  assert.equal(controller.getSessionIdForStream('stream-1'), 'canonical-session');
  assert.equal(controller.isStreamGenerationCurrent(sourceToken), false);
  assert.equal(
    controller.isStreamGenerationCurrent(
      controller.captureStreamGeneration('canonical-session', 'stream-1')
    ),
    true
  );
  assert.equal(controller.forgetSessionGeneration('canonical-session'), true);
  assert.equal(controller.isStreamCurrentForSession('canonical-session', 'different-stream'), true);
});

test('multi-stream controller bounds the finalized-stream registry and dispose clears it', () => {
  const controller = createMultiStreamController({ getState: () => ({ pendingToolApprovals: new Map() }), appendClientLog() {} });

  // Cap is 1024; finalize well past it and confirm the oldest entries are evicted
  // (the registry cannot grow without limit) while recent ones are retained.
  for (let i = 0; i < 1100; i += 1) {
    controller.markStreamFinalized(`stream-${i}`);
  }
  assert.equal(controller.isStreamFinalized('stream-0'), false, 'oldest finalized id evicted past the cap');
  assert.equal(controller.isStreamFinalized('stream-1099'), true, 'most recent finalized id retained');

  controller.dispose();
  assert.equal(controller.isStreamFinalized('stream-1099'), false, 'dispose clears the finalized registry');
});

test('per-session generation fence survives finalized tombstone eviction', () => {
  const controller = createMultiStreamController({ getState: () => ({ pendingToolApprovals: new Map() }), appendClientLog() {} });

  controller.registerStream('session-1', 'stream-old');
  controller.beginStreamTerminalCommit('stream-old', 'session-1');
  controller.clearStream('stream-old');
  controller.finishStreamTerminalCommit('stream-old', true, 'session-1');
  for (let index = 0; index < 1100; index += 1) {
    controller.markStreamFinalized(`stream-filler-${index}`);
  }
  assert.equal(controller.isStreamFinalized('stream-old'), false, 'precondition: diagnostic tombstone evicted');
  assert.equal(
    controller.registerStream('session-1', 'stream-old'),
    null,
    'the committed session generation still rejects resurrection'
  );
  assert.equal(controller.registerStream('session-1', 'stream-new'), 'stream-new');
});

test('multi-stream controller exposes approval-pending sessions as plain arrays', () => {
  const state = {
    pendingToolApprovals: new Map([
      ['call-1', { sessionId: 'session-1', streamId: 'stream-1' }],
      ['call-2', { sessionId: 'session-2', streamId: 'stream-2' }],
      ['call-3', { sessionId: 'session-1', streamId: 'stream-3' }],
    ]),
  };
  const controller = createMultiStreamController({ getState: () => state, appendClientLog() {} });

  assert.deepEqual(controller.getApprovalPendingSessionIds().sort(), ['session-1', 'session-2']);

  controller.dispose();
  assert.deepEqual(controller.getStreamingSessionIds(), []);
});

// Audit finding A5: an overlapping OLDER postwork continuation's finish must
// not tear down a NEWER generation's window. finishTerminalPostwork is
// compare-and-clear; clearTerminalPostwork stays the unconditional
// invalidation for delete/dispose teardowns.
test('finishTerminalPostwork is compare-and-clear: a stale token cannot clear a newer generation', () => {
  const controller = createMultiStreamController({ getState: () => ({}), appendClientLog() {} });

  const olderToken = controller.beginTerminalPostworkGeneration('session-1');
  const newerToken = controller.beginTerminalPostworkGeneration('session-1');
  assert.notEqual(olderToken, newerToken, 'each window mints a distinct token');

  assert.equal(
    controller.finishTerminalPostwork('session-1', olderToken),
    false,
    'the older continuation finishing must be a no-op'
  );
  assert.equal(
    controller.isSessionInTerminalPostwork('session-1'),
    true,
    'the newer generation keeps its busy window'
  );
  assert.equal(
    controller.isTerminalPostworkGenerationCurrent('session-1', newerToken),
    true,
    'the newer token stays current after the stale finish'
  );

  assert.equal(controller.finishTerminalPostwork('session-1', newerToken), true, 'the owner clears its own window');
  assert.equal(controller.isSessionInTerminalPostwork('session-1'), false);
});

test('finishTerminalPostwork with a null token falls back to the unconditional clear', () => {
  const controller = createMultiStreamController({ getState: () => ({}), appendClientLog() {} });
  controller.beginTerminalPostworkGeneration('session-1');

  assert.equal(controller.finishTerminalPostwork('session-1', null), true, 'legacy wiring can never strand busy');
  assert.equal(controller.isSessionInTerminalPostwork('session-1'), false);
});

test('clearTerminalPostwork stays unconditional (delete/dispose teardown)', () => {
  const controller = createMultiStreamController({ getState: () => ({}), appendClientLog() {} });
  const token = controller.beginTerminalPostworkGeneration('session-1');

  assert.equal(controller.clearTerminalPostwork('session-1'), true);
  assert.equal(controller.isSessionInTerminalPostwork('session-1'), false);
  assert.equal(
    controller.isTerminalPostworkGenerationCurrent('session-1', token),
    false,
    'the teardown invalidates the outstanding token'
  );
});
