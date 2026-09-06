// Regression: a settled turn phase must override stale streaming render
// options for reasoning rows (buildReasoningRowMarkup in
// renderer-turn-row-render-utils.js). Lives in its own file because the
// main renderer-turn-row-render-utils.test.js sits at the file-size
// ceiling.
const test = require('node:test');
const assert = require('node:assert/strict');

const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

test('reasoning rows in a settled turn render non-streaming even when streaming flags are stale', () => {
  const captured = [];
  const renderer = createTurnRowRenderUtils({
    MESSAGE_STATUS: { STREAMING: 'streaming' },
    escapeHtml,
    renderMarkdown: (text) => `<p>${escapeHtml(text)}</p>`,
    renderStreamingMarkdownUnits: (text) => ({
      html: `<p>${escapeHtml(text)}</p>`,
      units: [],
      changedStartIndex: 0,
    }),
    renderThinkingWidget(message, latestAssistantMessageId) {
      captured.push({ status: message.status, latest: latestAssistantMessageId });
      return '<div class="reasoning-test"></div>';
    },
  });
  const row = {
    row_id: 'row:reasoning-stale',
    turn_id: 'turn_stale',
    kind: 'reasoning',
    primary_message_id: 'assistant_stale',
    payload: {
      phase_id: 'phase_stale',
      thinking_id: 'think_stale',
      entries: [{ text: 'Settled thought' }],
    },
  };
  const messages = [{ id: 'assistant_stale', role: 'assistant', status: 'complete' }];

  // Stale flag: streamingMessageId still points at the row's shared
  // primary_message_id, but the turn phase is already terminal.
  renderer.buildTurnRowListMarkup([row], messages, {
    streamingMessageId: 'assistant_stale',
    turnPhase: 'done',
  });
  assert.equal(captured.length, 1);
  assert.equal(captured[0].status, 'complete', 'settled turn must not stamp streaming status');
  assert.equal(captured[0].latest, '', 'settled turn must not mark the reasoning row as the streaming tail');

  // Control: while the turn is active the same flags keep streaming behavior.
  renderer.buildTurnRowListMarkup([row], messages, {
    streamingMessageId: 'assistant_stale',
    turnPhase: 'streaming',
  });
  assert.equal(captured.length, 2);
  assert.equal(captured[1].status, 'streaming', 'active turn keeps the streaming render status');
  assert.equal(captured[1].latest, 'assistant_stale', 'active turn marks the reasoning row as the streaming tail');
});

test('each canonical reasoning row receives only its own transcript phase', () => {
  const captured = [];
  const renderer = createTurnRowRenderUtils({
    MESSAGE_STATUS: { STREAMING: 'streaming' },
    escapeHtml,
    renderMarkdown: (text) => `<p>${escapeHtml(text)}</p>`,
    renderStreamingMarkdownUnits: (text) => ({ html: `<p>${escapeHtml(text)}</p>`, units: [] }),
    renderThinkingWidget(message) {
      captured.push(message);
      return '<div class="reasoning-test"></div>';
    },
  });
  const rows = [
    {
      row_id: 'row:reasoning:turn_multi:phase_1',
      turn_id: 'turn_multi',
      kind: 'reasoning',
      primary_message_id: 'assistant_multi',
      phase_id: 'phase_1',
      payload: {
        phase_id: 'phase_1', thinking_id: 'think_shared',
        entries: [{ id: 'r1', text: 'first body', thinkingId: 'think_shared' }],
      },
    },
    {
      row_id: 'row:reasoning:turn_multi:phase_2',
      turn_id: 'turn_multi',
      kind: 'reasoning',
      primary_message_id: 'assistant_multi',
      phase_id: 'phase_2',
      payload: {
        phase_id: 'phase_2', thinking_id: 'think_shared',
        entries: [{ id: 'r2', text: 'second body', thinkingId: 'think_shared' }],
      },
    },
  ];
  const messages = [{
    id: 'assistant_multi',
    role: 'assistant',
    status: 'complete',
    phases: [
      { phase_id: 'phase_1', phase_kind: 'reasoning', thinking_id: 'think_shared', entries: rows[0].payload.entries },
      { phase_id: 'phase_2', phase_kind: 'reasoning', thinking_id: 'think_shared', entries: rows[1].payload.entries },
    ],
    reasoning_phases: [
      { phaseId: 'phase_1', phaseKind: 'reasoning', thinkingId: 'think_shared', completed: true },
      { phaseId: 'phase_2', phaseKind: 'reasoning', thinkingId: 'think_shared', completed: true },
    ],
  }];

  renderer.buildTurnRowListMarkup(rows, messages, { turnPhase: 'done' });

  assert.equal(captured.length, 2);
  assert.deepEqual(captured.map((message) => message.phases.map((phase) => phase.phase_id)), [
    ['phase_1'],
    ['phase_2'],
  ]);
  assert.deepEqual(captured.map((message) => message.reasoning_phases.map((phase) => phase.phaseId)), [
    ['phase_1'],
    ['phase_2'],
  ]);
  assert.deepEqual(captured.map((message) => message.reasoning_phases[0].completed), [true, true]);
  assert.deepEqual(captured.map((message) => message.reasoning.entries.map((entry) => entry.text)), [
    ['first body'],
    ['second body'],
  ]);
});
