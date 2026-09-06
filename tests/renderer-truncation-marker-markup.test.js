/**
 * tests/renderer-truncation-marker-markup.test.js
 *
 * EH-W5 gate — stream_reset truncation marker. The reducer sets
 * payload.truncated on assistant_text + reasoning rows
 * (markLatestAssistantRowsTruncated, covered by
 * tests/renderer-turn-reducer.test.js); the markup layer just honors
 * it with a subtle hairline + "restarted" label and nothing else.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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
    renderThinkingWidget(message) {
      return `<div class="reasoning-test" data-message-id="${escapeHtml(message.id)}"></div>`;
    },
    renderToolCallBlock() { return ''; },
    renderAgentStatusWidget() { return ''; },
    renderAssistantFailureNotice() { return ''; },
    renderContextCompactedNotice() { return ''; },
    ...overrides,
  });
}

function buildAssistantTextRow(truncated) {
  return {
    row_id: 'row:assistant',
    turn_id: 'turn_1',
    kind: 'assistant_text',
    primary_message_id: 'assistant_1',
    segment_group_index: 0,
    payload: {
      text: 'Partial answer before the reset.',
      segment_group_index: 0,
      truncated,
    },
  };
}

function buildReasoningRow(truncated) {
  return {
    row_id: 'row:reasoning',
    turn_id: 'turn_1',
    kind: 'reasoning',
    primary_message_id: 'assistant_1',
    phase_id: 'phase_1',
    payload: {
      phase_id: 'phase_1',
      entries: [],
      truncated,
    },
  };
}

test('truncated assistant_text row appends the marker after the bubble', () => {
  const renderer = createRenderer();
  const html = renderer.buildTurnRowListMarkup([buildAssistantTextRow(true)], []);

  assert.match(html, /chat-truncation-marker/);
  assert.match(html, /role="note"/);
  assert.match(html, /aria-label="Response restarted"/);
  assert.match(html, /restarted/);
  assert.ok(
    html.indexOf('chat-bubble') < html.indexOf('chat-truncation-marker'),
    'marker renders after the truncated content'
  );
});

test('non-truncated assistant_text row renders no marker', () => {
  const renderer = createRenderer();
  const html = renderer.buildTurnRowListMarkup([buildAssistantTextRow(false)], []);
  assert.ok(!html.includes('chat-truncation-marker'), 'no marker without the reducer flag');
});

test('truncated reasoning row appends the marker after the thinking widget', () => {
  const renderer = createRenderer();
  const html = renderer.buildTurnRowListMarkup([buildReasoningRow(true)], []);

  assert.match(html, /reasoning-test/);
  assert.match(html, /chat-truncation-marker/);
  assert.ok(
    html.indexOf('reasoning-test') < html.indexOf('chat-truncation-marker'),
    'marker renders after the widget'
  );
});

test('non-truncated reasoning row renders no marker', () => {
  const renderer = createRenderer();
  const html = renderer.buildTurnRowListMarkup([buildReasoningRow(false)], []);
  assert.ok(!html.includes('chat-truncation-marker'), 'no marker without the reducer flag');
});

test('a clean recovery emits no system notice and no extra chrome beyond the marker', () => {
  const renderer = createRenderer();
  const html = renderer.buildTurnRowListMarkup([
    buildReasoningRow(true),
    buildAssistantTextRow(true),
  ], []);
  assert.ok(!html.includes('chat-error-card'), 'no error card for a recovered reset');
  assert.ok(!html.includes('chat-system-notice'), 'no system notice for a recovered reset');
});

test('chat-system-notices-v2.css styles the truncation marker', () => {
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'styles', 'chat-system-notices-v2.css'),
    'utf8'
  );
  assert.ok(css.includes('.chat-truncation-marker {'), 'marker selector present');
  assert.ok(css.includes('.chat-truncation-marker-rule {'), 'hairline selector present');
});
