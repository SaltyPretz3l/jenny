// Row wrapper guard: renderer-turn-row-list-utils.js's buildRowWrapperMarkup no
// longer emits a per-row <span class="chat-row-node-dot"> (row 135: the sprite is
// the only gutter mark). A blank assistant_text row (streamed-then-interrupted
// segment) still carries an SR-only phase kicker as its bodyMarkup, so it must be
// flagged data-row-visually-empty, and a fully empty body must drop the whole row.
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

function createRenderer(overrides = {}) {
  return createTurnRowRenderUtils({
    MESSAGE_STATUS: { STREAMING: 'streaming' },
    escapeHtml,
    renderMarkdown(text) {
      return `<p>${escapeHtml(text)}</p>`;
    },
    renderStreamingMarkdownUnits(text) {
      return {
        html: `<p>${escapeHtml(text)}</p>`,
        units: [{ html: `<span>${escapeHtml(text)}</span>`, revealed: true, tail: true }],
        changedStartIndex: 0,
      };
    },
    renderThinkingWidget() {
      return '';
    },
    renderToolCallBlock() {
      return '';
    },
    renderAgentStatusWidget() {
      return '';
    },
    renderAssistantFailureNotice() {
      return '';
    },
    renderContextCompactedNotice() {
      return '';
    },
    ...overrides,
  });
}

test('node-dot guard: blank assistant_text row with only an SR-only phase kicker is flagged visually empty', () => {
  const renderer = createRenderer();
  const row = {
    row_id: 'row:blank-commentary',
    turn_id: 'turn_dot_1',
    kind: 'assistant_text',
    primary_message_id: 'assistant_blank',
    assistant_phase: 'commentary',
    payload: { text: '   ' },
  };

  const html = renderer.buildTurnRowListMarkup([row], [
    { id: 'assistant_blank', role: 'assistant', status: 'complete' },
  ], {});

  assert.match(html, /data-row-kind="assistant_text"/);
  assert.match(html, /data-row-visually-empty="true"/);
  assert.doesNotMatch(html, /chat-row-node-dot/);
  // The SR-only kicker itself must still render (a11y signal preserved).
  assert.match(html, /chat-commentary-kicker/);
});

test('node-dot guard: non-empty assistant_text row renders its body without a dot', () => {
  const renderer = createRenderer();
  const row = {
    row_id: 'row:visible-text',
    turn_id: 'turn_dot_2',
    kind: 'assistant_text',
    primary_message_id: 'assistant_visible',
    payload: { text: 'Hello there' },
  };

  const html = renderer.buildTurnRowListMarkup([row], [
    { id: 'assistant_visible', role: 'assistant', status: 'complete' },
  ]);

  assert.match(html, /data-row-kind="assistant_text"/);
  assert.doesNotMatch(html, /data-row-visually-empty/);
  assert.doesNotMatch(html, /chat-row-node-dot/);
  assert.match(html, /Hello there/);
});

test('node-dot guard: system_notice rows still render, without a dot', () => {
  const renderer = createRenderer();
  const row = {
    row_id: 'row:notice',
    turn_id: 'turn_dot_3',
    kind: 'system_notice',
    primary_message_id: '',
    payload: { subkind: 'orphan_carry', orphan_count: 1 },
  };

  const html = renderer.buildTurnRowListMarkup([row], []);

  assert.match(html, /data-row-kind="system_notice"/);
  assert.doesNotMatch(html, /chat-row-node-dot/);
  assert.match(html, /1 orphaned tool call was carried into a clean turn\./);
});

test('node-dot guard: fully empty body markup still drops the whole row (pre-existing behavior unchanged)', () => {
  const renderer = createRenderer();
  const row = {
    row_id: 'row:empty-text',
    turn_id: 'turn_dot_4',
    kind: 'assistant_text',
    primary_message_id: 'assistant_empty',
    payload: { text: '' },
  };

  const html = renderer.buildTurnRowListMarkup([row], [
    { id: 'assistant_empty', role: 'assistant', status: 'complete' },
  ]);

  assert.doesNotMatch(html, /chat-row-node-dot/);
  assert.doesNotMatch(html, /data-row-kind="assistant_text"/);
});
