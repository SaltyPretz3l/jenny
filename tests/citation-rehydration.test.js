'use strict';

// Citations Step 7 — the load-bearing end-to-end assertions:
// (a) rehydration: chips re-render from PERSISTED turn_events[] (the
//     dedicated-kind design's payoff), through tree projector -> row
//     projector -> the system-notice render switch;
// (b) flag-off parity at render: even a persisted source_citations event
//     produces no chip markup when the flag is off (the collector derive is
//     separately pinned flag-off in canonical-turn-event-collector.test.js).

const test = require('node:test');
const assert = require('node:assert/strict');

const { projectTurnTree } = require('../renderer/chat/renderer-turn-tree-projector');
const { projectTurnRows } = require('../renderer/chat/renderer-turn-row-projector');
const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');

const PERSISTED_SESSION = {
  messages: [
    { id: 'user_1', role: 'user', content: 'what is new with X' },
    { id: 'assistant_1', role: 'assistant', content: 'Here is what I found.', streamId: 'turn_web' },
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
          { url: 'https://example.com/one', title: 'One', snippet: 's1', sourceType: 'web' },
          { url: 'https://example.com/two', title: 'Two', snippet: 's2', sourceType: 'web' },
        ],
        truncated: false,
        tool_call_id: 'call_web',
      },
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

test('rehydration: persisted source_citations events re-render citation chips (flag on)', () => {
  const html = renderPersistedSession(true);
  assert.match(html, /class="citation-chips-row"/);
  assert.equal((html.match(/class="citation-chip"/g) || []).length, 2);
  assert.match(html, /href="https:\/\/example\.com\/one"/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, />One</, 'escaped title renders as the pill text');
});

test('flag-off render parity: the same persisted events produce no chip markup', () => {
  const html = renderPersistedSession(false);
  assert.doesNotMatch(html, /citation-chip/);
});
