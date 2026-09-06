'use strict';

// Chat error code -> Logs Activity deep link, row-builder half.
// Split out of renderer-turn-row-render-utils.test.js because that file sits
// at the file-size cap (same reason as renderer-turn-row-render-citation-
// markers.test.js). Covers what buildErrorCodeNoticeMarkup emits: the row's
// turn_id (which IS the turn's parent_stream_id) has to reach the error card
// chip and the legacy bare-row code, and neither may render a dead link when
// the row has no turn id.

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');
const errorRecoveryUtils = require('../renderer/chat/renderer-error-recovery-utils');

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

function errorRow(extra = {}) {
  return {
    row_id: 'row:error',
    kind: 'system_notice',
    primary_message_id: 'assistant_error',
    payload: {
      subkind: 'assistant_error',
      error_code: 'CMP-CHAT-0002',
      stream_error: 'Stream failed hard',
    },
    ...extra,
  };
}

/* errorRecoveryUtils injected empty => the card module reads as
 * "unavailable", which is the only way the bare @legacy-fallback row
 * renders. renderAssistantFailureNotice is silenced for the same reason. */
function legacyRenderer() {
  return createRenderer({
    errorRecoveryUtils: {},
    renderAssistantFailureNotice() { return ''; },
  });
}

test('legacy bare error row linkifies the code into the Activity deep link', () => {
  const html = legacyRenderer().buildTurnRowListMarkup([errorRow({ turn_id: 'stream_legacy_turn' })], []);

  assert.match(html, /class="chat-error-row"/);
  const code = html.match(/<span class="chat-error-code"[^>]*>/)[0];
  assert.ok(code.includes('role="link"'), 'legacy code is a link too');
  assert.ok(code.includes('tabindex="0"'), 'legacy code is focusable');
  assert.ok(code.includes('data-inv-error-action="open_logs"'), 'same delegated action contract');
  assert.ok(code.includes('data-stream-id="stream_legacy_turn"'), 'row turn_id is the stream id');
  assert.ok(
    code.includes('title="View this error&#39;s diagnostic event in Activity"'),
    'tooltip copy (the tooltip layer migrates title=)'
  );
});

test('legacy bare error row stays inert without a row turn id', () => {
  const html = legacyRenderer().buildTurnRowListMarkup([errorRow()], []);
  const code = html.match(/<span class="chat-error-code"[^>]*>/)[0];
  assert.ok(!code.includes('role="link"'), 'no dead link without a target');
  assert.ok(!code.includes('data-inv-error-action'), 'no action contract either');
});

test('projected error card receives the row turn id as its stream id', () => {
  /* Mirrors the production adapter in renderer-transcript-thinking.js: the
   * recovery path renders the unified card from the notice message, so the
   * row's turn_id has to be stamped onto that message to reach the chip. */
  const renderer = createRenderer({
    renderAssistantFailureNotice: (message) => errorRecoveryUtils.renderTimelineErrorCard(message),
  });
  const html = renderer.buildTurnRowListMarkup([errorRow({ turn_id: 'stream_card_turn' })], []);

  assert.match(html, /data-stream-id="stream_card_turn"/);
  assert.match(html, /class="chat-error-card chat-error-card--danger"/);
});

test('a message that already carries its own stream id keeps it', () => {
  const renderer = createRenderer({
    renderAssistantFailureNotice: (message) => `<i data-seen="${escapeHtml(message.stream_id || '')}"></i>`,
  });
  const rows = [errorRow({ turn_id: 'stream_row_turn' })];
  const messages = [{
    id: 'assistant_error',
    role: 'assistant',
    stream_error: 'Stream failed hard',
    stream_id: 'stream_from_message',
  }];

  const html = renderer.buildTurnRowListMarkup(rows, messages);
  assert.match(html, /data-seen="stream_from_message"/);
});
