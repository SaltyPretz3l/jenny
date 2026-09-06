'use strict';

// Pure settlement state machine for a PluginStreamFrameV1 stream
// (PLUGIN_SYSTEM_ARCHITECTURE_AND_ROADMAP.md, "Executable invocation topology").
//
// Design as a pure reducer, not a stateful class: `reduceFrame(state, frame, nowMs)`
// takes the previous immutable state and returns a NEW state plus an outcome,
// never mutating its input and never reading fs/net/an ambient clock. Callers
// (and tests, via tests/helpers/plugins/host-simulator.js) supply `nowMs` as a
// monotonic-clock reading from their own process; this module never calls
// Date.now()/performance.now() itself, so a wall-clock rollback in the host
// process cannot silently extend a deadline evaluated here.
//
// Invariants enforced (architecture invariant 17 + Stage-2 invocation/host
// protocol packet):
//   - sequence numbers are strictly monotonic per invocation; a duplicate or
//     lower sequence is rejected without mutating the settled state;
//   - exactly one terminal frame is ever accepted -- once `state.terminal` is
//     set, every subsequent frame (including a second, differently-tagged
//     terminal) is rejected and the recorded terminal never changes;
//   - a frame stamped with a commit_epoch/lifecycle_epoch that does not match
//     the epoch this settlement was opened under is rejected ("wrong-epoch");
//   - a frame whose payload or running totals exceed the invocation's own
//     bounded stream/result budgets is rejected ("over-budget");
//   - a frame arriving at or after the invocation deadline is rejected as
//     late.

const REJECT_REASONS = Object.freeze({
  ALREADY_TERMINAL: 'stream_already_terminal',
  WRONG_EPOCH: 'wrong_epoch',
  DUPLICATE_SEQUENCE: 'duplicate_sequence',
  OUT_OF_ORDER_SEQUENCE: 'out_of_order_sequence',
  FRAME_BUDGET_EXCEEDED: 'stream_frame_budget_exceeded',
  FRAME_PAYLOAD_BUDGET_EXCEEDED: 'frame_payload_budget_exceeded',
  STREAM_TOTAL_BUDGET_EXCEEDED: 'stream_total_budget_exceeded',
  FRAME_LATE: 'frame_late',
  MALFORMED_FRAME: 'malformed_frame',
  WRONG_INVOCATION: 'wrong_invocation',
  ACK_WINDOW_EXCEEDED: 'stream_ack_window_exceeded',
});

const { validate } = require('../contracts/generated-plugin-contracts');

function utf8Bytes(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

/**
 * @param {{commitEpoch:number, lifecycleEpoch:number, maxStreamFrames:number,
 *   maxFrameUtf8Bytes:number, maxStreamTotalUtf8Bytes:number,
 *   deadlineEpochMs:number}} context
 */
function initialSettlementState(context) {
  return Object.freeze({
    context: Object.freeze({ ...context }),
    lastSequence: -1,
    frameCount: 0,
    totalPayloadBytes: 0,
    terminal: null,
    acknowledgedSequence: -1,
    unackedCount: 0,
  });
}

function isSettled(state) {
  return state.terminal !== null;
}

function reject(state, code, path) {
  return { state, ok: false, error: { code, path: path || '' } };
}

function accept(state) {
  return { state, ok: true, error: null };
}

function framePayloadBytes(frame) {
  if (frame && frame.frame && typeof frame.frame.payload === 'string') {
    return utf8Bytes(frame.frame.payload);
  }
  return 0;
}

/**
 * Fold one inbound PluginStreamFrameV1-shaped frame into the settlement state.
 * Never throws: malformed input produces a rejected result, not an exception.
 */
function reduceFrame(state, frame, nowMs) {
  if (isSettled(state)) {
    return reject(state, REJECT_REASONS.ALREADY_TERMINAL, 'frame');
  }
  if (!frame || typeof frame !== 'object' || !frame.frame || typeof frame.frame.kind !== 'string') {
    return reject(state, REJECT_REASONS.MALFORMED_FRAME, 'frame');
  }
  if (typeof frame.sequence !== 'number' || !Number.isInteger(frame.sequence)) {
    return reject(state, REJECT_REASONS.MALFORMED_FRAME, 'frame.sequence');
  }
  const { context } = state;
  if (typeof context.invocationId === 'string' && frame.invocation_id !== context.invocationId) {
    return reject(state, REJECT_REASONS.WRONG_INVOCATION, 'frame.invocation_id');
  }
  if (frame.commit_epoch !== context.commitEpoch || frame.lifecycle_epoch !== context.lifecycleEpoch) {
    return reject(state, REJECT_REASONS.WRONG_EPOCH, 'frame.commit_epoch');
  }
  if (frame.sequence === state.lastSequence) {
    return reject(state, REJECT_REASONS.DUPLICATE_SEQUENCE, 'frame.sequence');
  }
  if (frame.sequence !== state.lastSequence + 1) {
    return reject(state, REJECT_REASONS.OUT_OF_ORDER_SEQUENCE, 'frame.sequence');
  }
  if (typeof nowMs === 'number' && typeof context.deadlineEpochMs === 'number' && nowMs >= context.deadlineEpochMs) {
    return reject(state, REJECT_REASONS.FRAME_LATE, 'frame');
  }
  if (state.frameCount + 1 > context.maxStreamFrames) {
    return reject(state, REJECT_REASONS.FRAME_BUDGET_EXCEEDED, 'frame');
  }
  const payloadBytes = framePayloadBytes(frame);
  if (payloadBytes > context.maxFrameUtf8Bytes) {
    return reject(state, REJECT_REASONS.FRAME_PAYLOAD_BUDGET_EXCEEDED, 'frame.frame.payload');
  }
  const nextTotalBytes = state.totalPayloadBytes + payloadBytes;
  if (nextTotalBytes > context.maxStreamTotalUtf8Bytes) {
    return reject(state, REJECT_REASONS.STREAM_TOTAL_BUDGET_EXCEEDED, 'frame.frame.payload');
  }
  const checked = validate('PluginStreamFrameV1', frame);
  if (!checked.ok) return reject(state, REJECT_REASONS.MALFORMED_FRAME, checked.error.path);
  const maxUnackedFrames = Number.isInteger(context.maxUnackedFrames) ? context.maxUnackedFrames : 8;
  if (state.unackedCount + 1 > maxUnackedFrames) {
    return reject(state, REJECT_REASONS.ACK_WINDOW_EXCEEDED, 'frame.sequence');
  }

  const isTerminal = frame.frame.kind === 'terminal';
  const nextState = Object.freeze({
    ...state,
    lastSequence: frame.sequence,
    frameCount: state.frameCount + 1,
    totalPayloadBytes: nextTotalBytes,
    terminal: isTerminal ? Object.freeze({ ...frame.frame }) : state.terminal,
    unackedCount: state.unackedCount + 1,
  });
  return accept(nextState);
}

function acknowledgeFrames(state, throughSequence) {
  if (!Number.isSafeInteger(throughSequence) || throughSequence <= state.acknowledgedSequence
    || throughSequence > state.lastSequence) return state;
  return Object.freeze({
    ...state,
    acknowledgedSequence: throughSequence,
    unackedCount: Math.max(0, state.lastSequence - throughSequence),
  });
}

module.exports = {
  REJECT_REASONS,
  initialSettlementState,
  reduceFrame,
  isSettled,
  acknowledgeFrames,
};
