/* tests/helpers/renderer-stream-reset-rig.js
 * Shared rig for the two stream_reset regression suites:
 *   - tests/renderer-stream-reset-assistant-id-alignment.test.js
 *     (main's next_assistant_message_id is the authority for the post-reset id)
 *   - tests/renderer-stream-reset-discard-scope.test.js
 *     (main's preserve_prior_segments / discard_scope drive the reducer's
 *      tombstone + segment renumbering)
 *
 * Real reducer wiring over a real turn-reducer state, driven by the real live
 * event handlers AND the real tool handlers: the oracle reads the rows the
 * production path actually built, and the tool boundary's segmentIndex bump
 * (with the latch clear that must ride with it) is production code, not
 * something a test may simulate.
 */
const { createStreamLiveEventHandlers } = require('../../renderer/chat/renderer-stream-handler-live-events');
const { createStreamToolHandlers } = require('../../renderer/chat/renderer-stream-handler-tools');
const { createReducerWiring } = require('../../renderer/chat/renderer-stream-handler-reducer-wiring');
const {
  buildTurnEventFromStreamPayload,
  createTurnReducerState,
  applyTurnStreamEvent,
  reconcileTurnRows,
} = require('../../renderer/chat/renderer-turn-reducer');

const SESSION_ID = 'session-reset-id';
const STREAM_ID = 'stream-reset-id';

function normalizeId(value) {
  return String(value == null ? '' : value).trim();
}

function makeRig(rigOptions = {}) {
  const deterministicRowId = rigOptions.deterministicRowId === true;
  const streamSegmentState = new Map();
  const liveStateBySession = new Map();

  function getSessionLiveTurnState(sessionId, options = {}) {
    const key = normalizeId(sessionId);
    if (!liveStateBySession.has(key) && options.create) {
      liveStateBySession.set(key, createTurnReducerState({ deterministicRowId }));
    }
    return liveStateBySession.get(key) || null;
  }

  const wiring = createReducerWiring({
    streamSegmentState,
    normalizeId,
    normalizeString: normalizeId,
    getSessionMessages: () => [],
    isRowModelEnabled: () => true,
    getSessionLiveTurnState,
    pruneEmptySessionLiveState: () => {},
    buildRolloutRowKey: (row) => normalizeId(row && row.row_id),
    buildTurnEventFromStreamPayload,
    applyTurnStreamEvent,
    reconcileTurnRows,
  });

  const state = {
    currentSessionId: SESSION_ID,
    pendingStreams: new Map(),
    toolCallsByStream: new Map(),
    pendingToolApprovals: new Map(),
  };
  const sessionMessages = [];

  const handlers = createStreamLiveEventHandlers({
    state,
    normalizeId,
    normalizeString: normalizeId,
    streamSegmentState,
    streamPhaseState: new Map(),
    reasoningStreamMerger: { drop() {}, merge: () => ({ source: 'none', entries: [] }) },
    pendingStreamCommitQueue: {
      peek: () => null,
      stage: () => {},
      flush: () => {},
      commitNow: () => {},
    },
    applyLiveTurnPayload: wiring.applyLiveTurnPayload,
    buildAssistantShellMessageId: wiring.buildAssistantShellMessageId,
    isRowModelEnabled: () => true,
  });

  const toolHandlers = createStreamToolHandlers({
    state,
    streamSegmentState,
    getSessionMessages: () => sessionMessages,
    setSessionMessages: (_sessionId, next) => {
      sessionMessages.length = 0;
      sessionMessages.push(...next);
    },
    isRowModelEnabled: () => true,
    applyLiveTurnPayload: wiring.applyLiveTurnPayload,
    MESSAGE_STATUS: { COMPLETE: 'complete', STREAMING: 'streaming' },
  });

  // Seed the pending bubble the live path would have created, then drive the
  // real tool_use handler — that is the only branch that advances the segment.
  async function crossToolBoundary(callId) {
    state.pendingStreams.set(STREAM_ID, 'pending-message');
    sessionMessages.length = 0;
    sessionMessages.push({
      id: 'pending-message',
      role: 'assistant',
      content: 'streamed so far',
      status: 'streaming',
    });
    await toolHandlers.handleToolUse({
      sessionId: SESSION_ID,
      streamId: STREAM_ID,
      type: 'tool_use',
      callId,
      toolName: 'read_file',
      status: 'running',
    });
  }

  const turn = () => getSessionLiveTurnState(SESSION_ID)?.turns_by_id?.[STREAM_ID] || null;
  const textRows = () => (turn()?.rows || []).filter((row) => row.kind === 'assistant_text');

  return {
    handlers,
    streamSegmentState,
    turn,
    textRows,
    deterministicRowId,
    crossToolBoundary,
    buildAssistantShellMessageId: wiring.buildAssistantShellMessageId,
  };
}

function payload(extra) {
  return { sessionId: SESSION_ID, streamId: STREAM_ID, ...extra };
}

function textRowGroupIndex(row) {
  return row.segment_group_index != null ? row.segment_group_index : row.payload.segment_group_index;
}

module.exports = {
  SESSION_ID,
  STREAM_ID,
  makeRig,
  normalizeId,
  payload,
  textRowGroupIndex,
};
