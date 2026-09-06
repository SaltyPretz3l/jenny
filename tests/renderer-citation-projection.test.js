'use strict';

// Citations Steps 3+4 — the `source_citations` persisted turn-event kind must
// be handled by BOTH projectors in lockstep (AGENTS.md kind contract):
// - tree projector: ordering slot (after tool_result) + persisted passthrough
// - row projector: a system_notice row carrying { subkind, refs }
// Lives in its own file: tests/renderer-turn-row-projector.test.js sits at
// the file-size cap.

const test = require('node:test');
const assert = require('node:assert/strict');

const treeProjector = require('../renderer/chat/renderer-turn-tree-projector');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const { createTraceEvent } = require('./helpers/renderer-turn-row-projector-helpers');

const REFS = [
  { url: 'https://example.com/a', title: 'Alpha', snippet: 'sa', sourceType: 'web' },
  { url: 'https://example.com/b', title: 'Beta', snippet: 'sb', sourceType: 'web' },
];

function citationEvent(overrides = {}) {
  return createTraceEvent({
    event_id: 'event-citations',
    kind: 'source_citations',
    tool_call_id: 'call_web',
    status: '',
    sort_key: [2, 1, 52],
    payload: { refs: REFS, truncated: false, tool_call_id: 'call_web' },
    ...overrides,
  });
}

test('tree projector orders source_citations after tool_result (kind priority slot)', () => {
  const priority = treeProjector.EVENT_KIND_PRIORITY;
  assert.ok(priority, 'EVENT_KIND_PRIORITY exported');
  assert.ok(Number(priority.source_citations) > Number(priority.tool_result),
    'citations sort below the producing tool_result');
  assert.ok(Number(priority.source_citations) < Number(priority.assistant_error),
    'citations sort above trailing notices');
});

test('tree projector passes a persisted source_citations event through hydration', () => {
  const tree = treeProjector.projectTurnTree({
    messages: [
      { id: 'user_1', role: 'user', content: 'search something' },
      { id: 'assistant_1', role: 'assistant', content: 'answer', streamId: 'turn_cite' },
    ],
    turn_event_log_version: 2,
    turn_events: [
      {
        event_id: 'turn_cite:user_prompt:0',
        turn_id: 'turn_cite',
        kind: 'user_prompt',
        event_seq: 0,
        primary_message_id: 'user_1',
        source_message_ids: ['user_1'],
        payload: { content: 'search something' },
      },
      {
        event_id: 'turn_cite:tool_result:0',
        turn_id: 'turn_cite',
        kind: 'tool_result',
        event_seq: 1,
        tool_call_id: 'call_web',
        primary_message_id: 'assistant_1',
        source_message_ids: ['assistant_1'],
        payload: { tool_name: 'web_search', output_text: '{}' },
      },
      {
        event_id: 'turn_cite:source_citations:0',
        turn_id: 'turn_cite',
        kind: 'source_citations',
        event_seq: 1,
        tool_call_id: 'call_web',
        primary_message_id: 'assistant_1',
        source_message_ids: ['assistant_1'],
        payload: { refs: REFS, truncated: false },
      },
    ],
  });
  const turn = (tree.turns || []).find((entry) => entry.turn_id === 'turn_cite');
  assert.ok(turn, 'hydrated turn present');
  const kinds = turn.events.map((event) => event.kind);
  assert.ok(kinds.includes('source_citations'), 'persisted kind survives hydration');
  assert.ok(
    kinds.indexOf('source_citations') > kinds.indexOf('tool_result'),
    'citations event ordered after its tool_result'
  );
  const citation = turn.events.find((event) => event.kind === 'source_citations');
  assert.equal(citation.payload.refs.length, 2, 'refs payload intact');
});

test('row projector emits exactly one source_citations system-notice row with refs', () => {
  const rows = projectTurnRows([
    createTraceEvent({ kind: 'tool_use', status: 'completed', sort_key: [0, 0, 40] }),
    createTraceEvent({
      event_id: 'event-result',
      kind: 'tool_result',
      status: 'completed',
      sort_key: [1, 0, 50],
      payload: { tool_name: 'web_search', output_text: '{}' },
    }),
    citationEvent(),
  ]);
  const citationRows = rows.filter((row) => row.payload && row.payload.subkind === 'source_citations');
  assert.equal(citationRows.length, 1, 'exactly one citations row');
  const row = citationRows[0];
  assert.equal(row.kind, 'system_notice');
  assert.deepEqual(row.payload.refs, REFS);
  // It must NOT be the unhandled fallback.
  assert.notEqual(row.payload.subkind, 'unhandled_source_citations');
});

test('row projector emits no citations row when the event is absent', () => {
  const rows = projectTurnRows([
    createTraceEvent({ kind: 'tool_use', status: 'completed', sort_key: [0, 0, 40] }),
  ]);
  assert.equal(rows.some((row) => row.payload && row.payload.subkind === 'source_citations'), false);
});

test('tree->row parity: the hydrated citations event projects to a citations row', () => {
  const tree = treeProjector.projectTurnTree({
    messages: [{ id: 'user_1', role: 'user', content: 'q' }],
    turn_event_log_version: 2,
    turn_events: [
      {
        event_id: 'turn_p:user_prompt:0',
        turn_id: 'turn_p',
        kind: 'user_prompt',
        event_seq: 0,
        primary_message_id: 'user_1',
        source_message_ids: ['user_1'],
        payload: { content: 'q' },
      },
      {
        event_id: 'turn_p:source_citations:0',
        turn_id: 'turn_p',
        kind: 'source_citations',
        event_seq: 1,
        tool_call_id: 'call_web',
        primary_message_id: 'user_1',
        source_message_ids: ['user_1'],
        payload: { refs: REFS, truncated: false },
      },
    ],
  });
  const turn = (tree.turns || []).find((entry) => entry.turn_id === 'turn_p');
  assert.ok(turn, 'turn hydrated');
  const rows = projectTurnRows(turn.events);
  const citationRows = rows.filter((row) => row.payload && row.payload.subkind === 'source_citations');
  assert.equal(citationRows.length, 1, 'tree and row projectors agree on the kind');
});
