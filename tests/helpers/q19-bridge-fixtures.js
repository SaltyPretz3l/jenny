'use strict';

// Phase 6 Q19 promotion bridge — shared test fixtures.
//
// Centralizes the sidecar-shaped ``tool_observations`` rows used by
// ``tests/tool-observation-promotion.test.js`` and
// ``tests/canonical-turn-event-q19-promotion.test.js`` so the Q19 input
// shape lives in one place. When the production observation shape
// changes (rare; gated by API_VERSION lockstep), these fixtures move
// with it and every Q19 test inherits the new shape automatically.
//
// Fixture rows are intentionally bare: each test sets ``request_id`` /
// ``turn_id`` to its own stream id when calling the factory so the
// promotion bridge's deduplication keys stay test-scoped.

const Q19_OBSERVATION_FIXTURES = Object.freeze({
  stuck_loop: Object.freeze({
    kind: 'turn_failed',
    error_code: 'CMP-LOOP-0018',
    summary: 'semantic stuck loop pattern=repeated_observations',
  }),
  max_iterations: Object.freeze({
    kind: 'turn_failed',
    error_code: 'CMP-LOOP-0001',
    summary: 'agent loop reached the maximum iteration depth',
  }),
  budget_exceeded: Object.freeze({
    kind: 'turn_failed',
    error_code: 'CMP-LOOP-0011',
    summary: 'per-turn budget exhausted',
  }),
  tool_cancelled: Object.freeze({
    kind: 'tool_execution_failed',
    error_code: 'CMP-LOOP-0013',
    tool_call_id: 'call-cancelled',
    tool_name: 'inspect_harness',
    summary: 'tool interrupted',
  }),
  approval_rejected: Object.freeze({
    kind: 'user_approval_rejected',
    error_code: 'CMP-APPROVAL-REJECTED',
    tool_call_id: 'call-denied',
    tool_name: 'write_file',
    summary: 'User rejected approval for write_file',
  }),
});

function makeSidecarToolObservation(name, requestId, sequence) {
  const base = Q19_OBSERVATION_FIXTURES[name];
  if (!base) {
    throw new Error(`Unknown Q19 fixture: ${name}`);
  }
  return {
    ...base,
    request_id: requestId,
    sequence,
  };
}

function makeAllSidecarToolObservations(requestId) {
  return [
    'stuck_loop',
    'max_iterations',
    'budget_exceeded',
    'tool_cancelled',
    'approval_rejected',
  ].map((name, index) => makeSidecarToolObservation(name, requestId, index + 1));
}

module.exports = {
  Q19_OBSERVATION_FIXTURES,
  makeSidecarToolObservation,
  makeAllSidecarToolObservations,
};
