'use strict';

// Shared by the Follow Jenny store tests: a store with a recorded event list,
// and the stream events a write_file call produces.

const { createFollowStore } = require('../../renderer/chat/renderer-follow-store');

// What a real tool event carries: every string of the input cut at 512 characters.
const clipped = (value) => (value.length > 512 ? `${value.slice(0, 512)}...` : value);
// An approval small enough to be shown exactly carries the real arguments and their hash.
const EXACT = { exact_approval: { schema_version: 1, fields: [], bytes: 1, sha256: 'a'.repeat(64) } };
const TOO_LARGE = { exact_approval: { schema_version: 1, too_large: true, bytes: 40000, limit_bytes: 32768 } };

function makeStore(overrides = {}) {
  const state = { enabled: true, active: 's1' };
  const events = [];
  const store = createFollowStore({
    isEnabled: () => state.enabled,
    getActiveSessionId: () => state.active,
    ...overrides,
  });
  store.subscribe((event) => events.push({ type: event.type, callId: event.call.callId, revision: event.call.revision, phase: event.call.phase }));
  return { store, state, events };
}

function delta(callId, argumentsDelta, extra = {}) {
  return {
    type: 'tool_input_delta',
    sessionId: 's1',
    streamId: 'st1',
    toolCallId: callId,
    toolName: 'write_file',
    argumentsDelta,
    argumentsBytes: typeof argumentsDelta === 'string' ? Buffer.byteLength(argumentsDelta) : 0,
    sequence: 1,
    ...extra,
  };
}

function toolUse(callId, input, extra = {}) {
  return { type: 'tool_use', sessionId: 's1', streamId: 'st1', toolName: 'write_file', callId, input, status: 'requested', ...extra };
}

function approval(callId, input, extra = {}) {
  return { type: 'tool_approval_needed', sessionId: 's1', streamId: 'st1', toolName: 'write_file', callId, input, ...extra };
}

function stream(store, callId, texts, extra = {}) {
  let bytes = 0;
  for (const piece of texts) {
    bytes += Buffer.byteLength(piece);
    store.noteStreamEvent(delta(callId, piece, { argumentsBytes: bytes, ...extra }));
  }
}

module.exports = { makeStore, delta, toolUse, approval, stream, clipped, EXACT, TOO_LARGE };
