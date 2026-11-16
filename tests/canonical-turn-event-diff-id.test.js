// Gate sitting 2026-11-14 (G5): the chat tool row reads its diff from turn_events[], and the
// sidecar's turn event carries `diff_id: ""`. Only the message copy got Electron's generated id,
// so "Open diff in editor" (row 160) never rendered. The collector fills an empty id with the same
// id the message copy gets, so both copies name the same change.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { CanonicalTurnEventCollector } = require('../services/backend/canonical-turn-event-collector');
const { normalizeToolResultDiffMetadata } = require('../services/backend/tool-result-diff-metadata');

function diff(extra = {}) {
  return {
    diff_id: '',
    operation_index: 0,
    path: 'site.css',
    status: 'modified',
    review_state: 'full',
    body_kind: 'inline_hunks',
    additions: 1,
    deletions: 1,
    hunks: [{ old_start: 2, old_lines: 1, new_start: 2, new_lines: 1, lines: ['-a', '+b'] }],
    ...extra,
  };
}

function collect(metadata) {
  const collector = new CanonicalTurnEventCollector({ turnId: 'turn_1', attemptId: 'stream_1', sessionId: '' });
  return collector.noteEvent({
    kind: 'tool_result', turn_id: 'turn_1', event_id: 'evt-result', tool_call_id: 'call_edit',
    status: 'completed', payload: { tool_name: 'edit_file', metadata },
  });
}

test('an empty diff_id takes the id the message copy gets', () => {
  const expected = normalizeToolResultDiffMetadata(diff(), { streamId: 'stream_1', callId: 'call_edit' }).diff_id;
  assert.ok(expected, 'the message copy has a generated id');
  const captured = collect({ diff: diff() });
  assert.equal(captured.payload.metadata.diff.diff_id, expected);
});

test('each entry of diffs[] is filled by its own operation index; a real id is kept', () => {
  const second = diff({ operation_index: 1, path: 'menu.html' });
  const expected = normalizeToolResultDiffMetadata(second, { streamId: 'stream_1', callId: 'call_edit' }).diff_id;
  const captured = collect({ diffs: [diff({ diff_id: 'scripted:call:0' }), second] });
  assert.equal(captured.payload.metadata.diffs[0].diff_id, 'scripted:call:0');
  assert.equal(captured.payload.metadata.diffs[1].diff_id, expected);
  assert.notEqual(expected, '');
});

test('a tool_result without a diff is left alone', () => {
  const captured = collect({ trace_id: 't' });
  assert.deepEqual(captured.payload.metadata, { trace_id: 't' });
});
