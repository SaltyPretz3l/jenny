'use strict';

// Fable B2 review P3: an approval pending across the HB-012 upgrade was
// persisted with path-redacted input; the decision projection must still prove.
const test = require('node:test');
const assert = require('node:assert/strict');

const { decisionProjection } = require('../services/backend/runtime-continuation-effects');
const {
  buildPersistedToolInputSnapshot,
  redactPathLikeText,
} = require('../services/backend/tool-loop-input-sanitization');

const ARGS = { path: 'C:\\Users\\someone\\bank_recon\\src\\cli.py', content: 'print(1)' };
const CONTEXT = {
  decision: { kind: 'approval', call_id: 'call_1' },
  sessionId: 's1',
  turnId: 't1',
  streamId: 'st1',
  pendingCalls: [{ call_id: 'call_1', tool_id: 'write_file', arguments: ARGS }],
};

function pendingEvent(input) {
  return {
    kind: 'tool_use',
    status: 'pending_approval',
    turn_id: 't1',
    tool_call_id: 'call_1',
    event_id: 't1:tool_use:3:st1',
    payload: {
      approval_id: 'approval_s1_st1_call_1',
      parent_stream_id: 'st1',
      tool_name: 'write_file',
      input,
    },
  };
}

test('current raw-path input proves the pending decision', () => {
  const input = buildPersistedToolInputSnapshot(ARGS).input;
  assert.equal(decisionProjection(pendingEvent(input), CONTEXT), true);
});

test('pre-HB-012 path-redacted input still proves the pending decision', () => {
  const legacy = { ...buildPersistedToolInputSnapshot(ARGS).input };
  legacy.path = redactPathLikeText(legacy.path);
  assert.notEqual(legacy.path, ARGS.path);
  assert.equal(decisionProjection(pendingEvent(legacy), CONTEXT), true);
});

test('input for different arguments does not prove', () => {
  const other = buildPersistedToolInputSnapshot({ ...ARGS, content: 'print(2)' }).input;
  assert.equal(decisionProjection(pendingEvent(other), CONTEXT), false);
});
