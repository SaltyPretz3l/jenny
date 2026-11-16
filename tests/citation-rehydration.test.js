'use strict';

// Citations Step 7 — the load-bearing end-to-end assertions:
// (a) rehydration: numbered references and the sources list re-render from PERSISTED turn_events[] (the
//     dedicated-kind design's payoff), through tree projector -> row
//     projector -> the system-notice render switch;
// (b) flag-off parity at render: even a persisted source_citations event
//     produces no source markup when the flag is off (the collector derive is
//     separately pinned flag-off in canonical-turn-event-collector.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');

const PERSISTED_SESSION = {
  messages: [
    { id: 'user_1', role: 'user', content: 'what is new with X' },
    { id: 'assistant_1', role: 'assistant', content: 'Here is what I found [web:2].', streamId: 'turn_web' },
  ],
  turn_event_log_version: 3,
  turn_events: [
    {
      event_id: 'turn_web:user_prompt:0',
      turn_id: 'turn_web',
      kind: 'user_prompt',
      event_seq: 0,
      primary_message_id: 'user_1',
      source_message_ids: ['user_1'],
      payload: { content: 'what is new with X' },
    },
    {
      event_id: 'turn_web:tool_result:0',
      turn_id: 'turn_web',
      kind: 'tool_result',
      event_seq: 1,
      tool_call_id: 'call_web',
      primary_message_id: 'assistant_1',
      source_message_ids: ['assistant_1'],
      payload: { tool_name: 'web_search', output_text: '{}' },
    },
    {
      event_id: 'turn_web:source_citations:call_web',
      turn_id: 'turn_web',
      kind: 'source_citations',
      event_seq: 2,
      tool_call_id: 'call_web',
      primary_message_id: 'assistant_1',
      source_message_ids: ['assistant_1'],
      payload: {
        refs: [
          { url: 'https://example.com/one', title: 'One', snippet: 's1', sourceType: 'web', n: 1 },
          { url: 'https://example.com/two', title: 'Two', snippet: 's2', sourceType: 'web', n: 2 },
        ],
        truncated: false,
        tool_call_id: 'call_web',
      },
    },
    {
      event_id: 'turn_web:assistant_text_segment:0',
      turn_id: 'turn_web',
      kind: 'assistant_text_segment',
      event_seq: 3,
      primary_message_id: 'assistant_1',
      source_message_ids: ['assistant_1'],
      assistant_phase: 'final_answer',
      payload: { text: 'Here is what I found [web:2].', segment_id: 'seg_0', message_index: 0, segment_index: 0 },
    },
  ],
};

function renderPersistedSession(flagOn) {
  const tree = projectTurnTree(PERSISTED_SESSION);
  const turn = (tree.turns || []).find((entry) => entry.turn_id === 'turn_web');
  assert.ok(turn, 'persisted turn hydrates');
  const rows = projectTurnRows(turn.events);
  const renderer = createTurnRowRenderUtils({
    getFeatureFlags: () => ({ source_citations: flagOn === true }),
  });
  return renderer.buildTurnRowListMarkup(rows, PERSISTED_SESSION.messages);
}

test('rehydration: persisted source_citations events re-render numbered references and the sources list (flag on)', () => {
  const html = renderPersistedSession(true);
  assert.equal((html.match(/<section class="source-list"/g) || []).length, 1);
  assert.equal((html.match(/<sup class="source-ref">/g) || []).length, 1);
  assert.match(html, /data-source-ref="1"[^>]*>Two<\/a>/, 'the cited source is reference 1');
  assert.match(html, /Also searched 1 more/);
  assert.match(html, /href="https:\/\/example\.com\/one"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.doesNotMatch(html, /\[web:2\]|citation-chip/);
});

test('rehydration: events saved before numbering (no n) render the unnumbered list', () => {
  const legacy = JSON.parse(JSON.stringify(PERSISTED_SESSION));
  legacy.turn_events = legacy.turn_events.filter((event) => event.kind !== 'assistant_text_segment');
  for (const event of legacy.turn_events) {
    if (event.kind === 'source_citations') for (const entry of event.payload.refs) delete entry.n;
  }
  const tree = projectTurnTree(legacy);
  const rows = projectTurnRows(tree.turns.find((entry) => entry.turn_id === 'turn_web').events);
  const html = createTurnRowRenderUtils({ getFeatureFlags: () => ({ source_citations: true }) })
    .buildTurnRowListMarkup(rows, legacy.messages);
  assert.match(html, /source-list--plain/);
  assert.doesNotMatch(html, /source-ref"|source-list-toggle/);
  assert.equal((html.match(/class="source-list-item"/g) || []).length, 2);
});

test('flag-off render parity: the same persisted events produce no source markup', () => {
  const html = renderPersistedSession(false);
  assert.doesNotMatch(html, /citation-chip|source-list|source-ref/);
  assert.match(html, /\[web:2\]/);
});
