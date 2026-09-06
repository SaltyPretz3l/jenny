// Phase 2 (response_loop_display_v2) commentary/intermediate styling: the
// pure row builders surface data-assistant-phase on the wrapper + an SR-only
// kicker outside the markdown bubble, gated by renderOptions.responseLoopDisplayV2.
// Kept in its own file so the broad renderer-turn-row-render-utils suite stays
// under the file-size ceiling.
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

function createRenderer() {
  return createTurnRowRenderUtils({
    MESSAGE_STATUS: { STREAMING: 'streaming' },
    escapeHtml,
    renderMarkdown(text) {
      return `<p>${escapeHtml(text)}</p>`;
    },
  });
}

function renderRow(row, options) {
  const renderer = createRenderer();
  return renderer.buildTurnRowListMarkup(
    [row],
    [{ id: row.primary_message_id, role: 'assistant', content: row.payload.text }],
    options,
  );
}

test('commentary row gets a phase wrapper + SR kicker under the display flag', () => {
  const html = renderRow(
    {
      turn_id: 'turn_c',
      kind: 'assistant_text',
      primary_message_id: 'assistant_seg0',
      assistant_phase: 'commentary',
      payload: { text: 'Let me check.', segment_group_index: 0 },
    },
    { responseLoopDisplayV2: true },
  );
  assert.match(html, /data-assistant-phase="commentary"/);
  assert.match(html, /<span class="chat-commentary-kicker"><span class="sr-only">Commentary<\/span><\/span>/);
  // The kicker renders OUTSIDE (before) the markdown bubble, not inside it.
  assert.ok(html.indexOf('chat-commentary-kicker') < html.indexOf('chat-bubble-markdown'));
});

test('intermediate row gets the continued-response kicker under the flag', () => {
  const html = renderRow(
    {
      turn_id: 'turn_i',
      kind: 'assistant_text',
      primary_message_id: 'assistant_seg1',
      assistant_phase: 'intermediate',
      payload: { text: 'Now the next step.', segment_group_index: 1 },
    },
    { responseLoopDisplayV2: true },
  );
  assert.match(html, /data-assistant-phase="intermediate"/);
  assert.match(html, /chat-commentary-kicker"><span class="sr-only">Continued response/);
});

test('final_answer keeps full emphasis: phase attr present, no kicker', () => {
  const html = renderRow(
    {
      turn_id: 'turn_f',
      kind: 'assistant_text',
      primary_message_id: 'assistant_final',
      assistant_phase: 'final_answer',
      payload: { text: 'The answer.', segment_group_index: 2 },
    },
    { responseLoopDisplayV2: true },
  );
  assert.match(html, /data-assistant-phase="final_answer"/);
  assert.doesNotMatch(html, /chat-commentary-kicker/);
});

test('flag-off commentary row renders without the phase attr or kicker (no regression)', () => {
  // No responseLoopDisplayV2 option and no document => resolves to flag-off.
  const html = renderRow(
    {
      turn_id: 'turn_off',
      kind: 'assistant_text',
      primary_message_id: 'assistant_off',
      assistant_phase: 'commentary',
      payload: { text: 'Let me check.', segment_group_index: 0 },
    },
    undefined,
  );
  assert.doesNotMatch(html, /data-assistant-phase/);
  assert.doesNotMatch(html, /chat-commentary-kicker/);
});
