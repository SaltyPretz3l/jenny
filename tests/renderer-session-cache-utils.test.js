'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { createSessionCacheController } = require('../renderer/shell/renderer-session-cache-utils');

function makeState(overrides = {}) {
  return {
    currentSessionId: '',
    activeStreamId: '',
    messagesBySession: new Map(),
    pendingStreams: new Map(),
    pendingToolApprovals: new Map(),
    sendPreflight: null,
    ...overrides,
  };
}

describe('renderer-session-cache-utils getPinnedSessionIds', () => {
  test('pins exactly the sessions whose stream set holds a pending stream id', () => {
    const state = makeState({
      messagesBySession: new Map([
        ['sessionA', [{ streamId: 'streamA' }]],
        ['sessionB', [{ streamId: 'streamB' }]],
        ['sessionC', [{ streamId: 'streamC' }]],
      ]),
      // Only streamA and streamC are still in flight.
      pendingStreams: new Map([['streamA', {}], ['streamC', {}]]),
    });
    const controller = createSessionCacheController({ state, getMultiStreamController: () => null });

    const pinned = controller.getPinnedSessionIds();

    assert.equal(pinned.has('sessionA'), true, 'sessionA owns a pending stream -> pinned');
    assert.equal(pinned.has('sessionC'), true, 'sessionC owns a pending stream -> pinned');
    assert.equal(pinned.has('sessionB'), false, 'sessionB has no pending stream -> not pinned');
  });

  test('pins a stream id carried by a tool_call / tool_result parent stream', () => {
    const state = makeState({
      messagesBySession: new Map([
        ['sessionA', [{ tool_call: { parent_stream_id: 'streamX' } }]],
        ['sessionB', [{ tool_result: { parent_stream_id: 'streamY' } }]],
      ]),
      pendingStreams: new Map([['streamX', {}]]),
    });
    const controller = createSessionCacheController({ state, getMultiStreamController: () => null });

    const pinned = controller.getPinnedSessionIds();

    assert.equal(pinned.has('sessionA'), true, 'tool_call parent stream is in flight -> pinned');
    assert.equal(pinned.has('sessionB'), false, 'tool_result parent stream is not pending -> not pinned');
  });

  test('still pins the current session, approvals, and send preflight regardless of pending streams', () => {
    const state = makeState({
      currentSessionId: 'sessionCurrent',
      messagesBySession: new Map([['sessionOther', [{ streamId: 'streamO' }]]]),
      pendingToolApprovals: new Map([['call-1', { sessionId: 'sessionApproval' }]]),
      sendPreflight: { sessionId: 'sessionPreflight' },
    });
    const controller = createSessionCacheController({ state, getMultiStreamController: () => null });

    const pinned = controller.getPinnedSessionIds();

    assert.equal(pinned.has('sessionCurrent'), true);
    assert.equal(pinned.has('sessionApproval'), true);
    assert.equal(pinned.has('sessionPreflight'), true);
    assert.equal(pinned.has('sessionOther'), false, 'no pending stream owns sessionOther');
  });
});
