// HB-038 H1 (dogfood, 2026-10-04): when the thinking guard cuts a think off,
// its phase completes and the same think continues in a new phase. The
// finished panel collapsed at once and the pinned tail dropped 1.6K-2.4K px
// (4 of 4 large jumps came 75-142 ms after a thinking_budget_abort). While the
// turn is live and only reasoning follows, the finished phase stays open; it
// collapses once a tool row, the answer or the turn's end arrives.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');
const { createReasoningV2Renderer } = require('../renderer/chat/renderer-transcript-reasoning-v2');
const {
  ThinkingPanelController,
  groupReasoningByPhase,
  shouldShowThinkingToggle,
} = require('../renderer/chat/chat-thinking-utils');

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function createRowRenderer() {
  const v2 = createReasoningV2Renderer({
    escapeHtml,
    groupReasoningByPhase,
    getReasoningEntries: (message) => (message && message.reasoning && message.reasoning.entries) || [],
    renderMarkdown: (text) => `<p>${escapeHtml(text)}</p>`,
    renderStreamingMarkdownUnits: (text) => ({ html: `<p>${escapeHtml(text)}</p>` }),
    shouldShowThinkingToggle,
    thinkingController: new ThinkingPanelController(),
  });
  return createTurnRowRenderUtils({
    MESSAGE_STATUS: { STREAMING: 'streaming' },
    escapeHtml,
    renderMarkdown: (text) => `<p>${escapeHtml(text)}</p>`,
    renderStreamingMarkdownUnits: (text) => ({
      html: `<p>${escapeHtml(text)}</p>`,
      units: [{ html: `<span>${escapeHtml(text)}</span>`, revealed: true, tail: true }],
      changedStartIndex: 0,
    }),
    renderThinkingWidget: v2.renderThinkingWidget,
  });
}

function reasoningRow(id, extra) {
  return {
    row_id: id,
    turn_id: 'turn_live',
    kind: 'reasoning',
    primary_message_id: 'assistant_seg1',
    payload: { phase_id: `${id}:phase`, thinking_id: `${id}:think`, entries: [{ text: `${id} thinking` }], ...extra },
  };
}

const CUT_OFF = reasoningRow('cut', { completed_at: '2026-10-04T22:27:00.000Z' });
const CONTINUED = reasoningRow('continued');
const ANSWER = {
  row_id: 'answer', turn_id: 'turn_live', kind: 'assistant_text', primary_message_id: 'assistant_seg1',
  payload: { text: 'The answer.' },
};
const MESSAGES = [{ id: 'assistant_seg1', role: 'assistant', status: 'streaming' }];
const LIVE = { isStreaming: true, streamingMessageId: 'assistant_seg1', turnLive: true };

function cutOffPanel(rows, options) {
  const html = createRowRenderer().buildTurnRowListMarkup(rows, MESSAGES, options);
  const body = new JSDOM(`<body>${html}</body>`).window.document.body;
  const panel = body.querySelector('.reasoning-row-panel[data-phase-key="cut:phase"]');
  assert.ok(panel, 'the cut-off phase renders a panel');
  return { open: panel.classList.contains('expanded') && !panel.hasAttribute('hidden') };
}

test('a cut-off phase stays open while its continuation streams', () => {
  assert.equal(cutOffPanel([CUT_OFF, CONTINUED], LIVE).open, true);
  // Also in the gap before the continuation's first delta.
  assert.equal(cutOffPanel([CUT_OFF], LIVE).open, true);
});

test('the cut-off phase collapses once the answer arrives', () => {
  assert.equal(cutOffPanel([CUT_OFF, CONTINUED, ANSWER], LIVE).open, false);
});

test('a settled or no longer live turn collapses it as before', () => {
  assert.equal(cutOffPanel([CUT_OFF, CONTINUED], { ...LIVE, turnLive: false }).open, false);
  assert.equal(cutOffPanel([CUT_OFF, CONTINUED], { ...LIVE, turnPhase: 'done' }).open, false);
});

test('the Answers view still keeps every reasoning panel closed', () => {
  assert.equal(cutOffPanel([CUT_OFF, CONTINUED], { ...LIVE, transcriptView: 'answers' }).open, false);
});
