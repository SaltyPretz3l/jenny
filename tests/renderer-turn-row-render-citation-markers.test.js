'use strict';

// Regression (queue #13 R3 remediation) — split out of
// renderer-turn-row-render-utils.test.js because that file sits at the
// file-size cap. Drive evidence (docs/plans/executor-handoffs/
// QUEUE_DRIVE_REPORT_2026-07-05.md #13) showed the model's visible answer
// keeping a raw 【web:N】 citation marker even with source_citations ON and
// zero citation-chip elements in the DOM. Once source_citations is on, the
// settled (non-streaming) assistant bubble should have recognized markers
// stripped; flag-off must stay byte-identical to today (raw marker visible)
// — the same parity contract the collector/row derive already holds to.

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
    ...overrides,
  });
}

function citationMarkerRow(text) {
  return {
    row_id: 'row:assistant-citation',
    turn_id: 'turn_web',
    kind: 'assistant_text',
    primary_message_id: 'assistant_web',
    payload: { text, segment_group_index: 0 },
  };
}

test('flag ON: a settled assistant bubble has [web:N]/【web:N】 markers stripped', () => {
  const renderer = createRenderer({ getFeatureFlags: () => ({ source_citations: true }) });
  const html = renderer.buildTurnRowListMarkup(
    [citationMarkerRow('The tower was completed in 1889【web:1】【web:7】.')],
    [{ id: 'assistant_web', role: 'assistant', content: 'The tower was completed in 1889【web:1】【web:7】.' }]
  );
  assert.doesNotMatch(html, /web:1/);
  assert.doesNotMatch(html, /【|】/);
  assert.match(html, /<p>The tower was completed in 1889\.<\/p>/);
});

test('flag OFF (default): the raw marker renders untouched — byte-identical to today', () => {
  const renderer = createRenderer();
  const html = renderer.buildTurnRowListMarkup(
    [citationMarkerRow('The tower was completed in 1889【web:1】.')],
    [{ id: 'assistant_web', role: 'assistant', content: 'The tower was completed in 1889【web:1】.' }]
  );
  assert.match(html, /<p>The tower was completed in 1889【web:1】\.<\/p>/);
});

test('flag ON: a streaming assistant bubble is left untouched (markers only strip once settled)', () => {
  const renderer = createRenderer({ getFeatureFlags: () => ({ source_citations: true }) });
  const row = citationMarkerRow('partial answer 【web:1');
  const html = renderer.buildTurnRowListMarkup(
    [row],
    [{ id: 'assistant_web', role: 'assistant', content: 'partial answer 【web:1', streamId: 'turn_web' }],
    { isStreaming: true, streamingRowId: 'turn_web:assistant_text:0', streamingMessageId: 'assistant_web' }
  );
  assert.match(html, /partial answer 【web:1/);
});
