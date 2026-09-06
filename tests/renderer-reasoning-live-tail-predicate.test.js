// Live-reasoning-row predicate pins (owner report 2026-08-29: a still-streaming
// reasoning phase painted the SETTLED row — green `status-dot--ok`, the
// past-tense name "Thought", no shimmer — and, because
// `data-reasoning-live-tail` is the only signal the toggle handler uses to
// grant the follow exemption, expanding it armed PAUSE_REASON_REASONING_EXPANDED
// and scroll-follow died for the rest of the turn.
//
// Root cause: "which message is streaming right now" is answered by two
// different ids computed in the SAME pass of computeDerivedMessageState —
// `latestAssistantMessageId` (any assistant kind, tool plumbing INCLUDED) and
// the stream-target scan that backs `streamingMessage` (tool plumbing skipped,
// see STREAM_TAIL_PLUMBING_KINDS). The reasoning/streaming render gates consume the
// former where they mean the latter, so a tool_use row trailing the live
// segment — the ordering already pinned by
// tests/renderer-chat-stream-repaint.test.js ("a second tool starting while
// seg1 still streams appends a tool_use AFTER the segment") — flips the live
// reasoning row to its settled presentation.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { computeDerivedMessageState } = require('../renderer/chat/renderer-message-index-utils');
const { createTurnRowRenderUtils } = require('../renderer/chat/renderer-turn-row-render-utils');
const { createReasoningV2Renderer } = require('../renderer/chat/renderer-transcript-reasoning-v2');
const {
  ThinkingPanelController,
  groupReasoningByPhase,
  shouldShowThinkingToggle,
} = require('../renderer/chat/chat-thinking-utils');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── A. one canonical "who is streaming right now" id ── */

function buildPostToolTranscript(trailing = []) {
  return [
    { id: 'user_1', role: 'user', kind: '', status: 'complete', content: 'hi' },
    { id: 'assistant_stream-x', role: 'assistant', kind: '', status: 'complete', content: 'pre-tool' },
    { id: 'tool_use_stream-x_c1', role: 'assistant', kind: 'tool_use', status: 'complete', content: 'Run tool' },
    { id: 'tool_result_stream-x_c1', role: 'tool', kind: 'tool_result', status: 'complete', content: 'ok' },
    { id: 'assistant_stream-x_seg1', role: 'assistant', kind: '', status: 'streaming', content: '' },
    ...trailing,
  ];
}

test('computeDerivedMessageState exposes a stream-target id that survives a trailing tool_use', () => {
  const derived = computeDerivedMessageState(buildPostToolTranscript([
    { id: 'tool_use_stream-x_c2', role: 'assistant', kind: 'tool_use', status: 'complete', content: 'Run tool 2' },
  ]));

  // The plain "latest assistant" id adopts the tool row — that is its job, and
  // retry/hover targeting still wants it.
  assert.equal(derived.latestAssistantMessageId, 'tool_use_stream-x_c2');
  // The streaming gates need the stream-target id instead, and it must name the
  // same message `streamingMessage` resolved to.
  assert.equal(derived.streamTargetAssistantMessageId, 'assistant_stream-x_seg1');
  assert.equal(derived.streamingMessage && derived.streamingMessage.id, derived.streamTargetAssistantMessageId);
});

test('the stream-target id equals the latest assistant id when no tool row trails the live segment', () => {
  const derived = computeDerivedMessageState(buildPostToolTranscript());

  assert.equal(derived.latestAssistantMessageId, 'assistant_stream-x_seg1');
  assert.equal(derived.streamTargetAssistantMessageId, 'assistant_stream-x_seg1');
});

test('a plan_document appended mid-turn does not strand the streaming target', () => {
  // handleApprovalNeeded (renderer-stream-handler-tools.js) pushes a
  // role:'assistant' kind:'plan_document' message onto the END of the list and
  // — unlike handleToolUse — never finalizes the pending segment, so in plan
  // mode a still-streaming segment is routinely trailed by a settled plan row.
  // Adopting it as the stream target nulls `streamingMessage`, which renders
  // the WHOLE turn settled and stalls delta patching.
  const derived = computeDerivedMessageState(buildPostToolTranscript([
    {
      id: 'plan_document_plan_1',
      role: 'assistant',
      kind: 'plan_document',
      status: 'complete',
      content: 'Implementation plan',
    },
  ]));

  assert.equal(derived.streamTargetAssistantMessageId, 'assistant_stream-x_seg1');
  assert.equal(derived.streamingMessage && derived.streamingMessage.id, 'assistant_stream-x_seg1');
});

test('the stream-target id follows a settled remnant rather than adopting a stale streaming row', () => {
  // A newer plain assistant message means the mid-transcript "streaming"
  // message is a remnant, not the live tail (mirrors the no-over-reach pin in
  // tests/renderer-chat-stream-repaint.test.js).
  const derived = computeDerivedMessageState(buildPostToolTranscript([
    { id: 'assistant_newer', role: 'assistant', kind: '', status: 'complete', content: 'newer' },
  ]));

  assert.equal(derived.streamingMessage, null);
  assert.equal(derived.streamTargetAssistantMessageId, 'assistant_newer');
});

/* ── B. the row-model reasoning row is scoped to the live MESSAGE, not the turn ── */

// The REAL reasoning renderer, not a stub: the whole defect lives in the
// attributes renderPhase stamps (`data-reasoning-live-tail`, `status-dot--*`,
// the Thinking/Thought name), so a stub that echoes its arguments would pin
// nothing.
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

function buildReasoningRow(rowId, messageId, payloadExtra) {
  return {
    row_id: rowId,
    turn_id: 'turn_live',
    kind: 'reasoning',
    primary_message_id: messageId,
    payload: Object.assign({
      phase_id: rowId + ':phase',
      thinking_id: rowId + ':think',
      entries: [{ text: 'thinking' }],
    }, payloadExtra || {}),
  };
}

const LIVE_TURN_MESSAGES = [
  { id: 'assistant_seg0', role: 'assistant', status: 'complete' },
  { id: 'assistant_seg1', role: 'assistant', status: 'streaming' },
];

test('an open reasoning phase on the live streaming segment renders as the live tail', () => {
  const renderer = createRowRenderer();
  const html = renderer.buildTurnRowListMarkup(
    [buildReasoningRow('row:live', 'assistant_seg1')],
    LIVE_TURN_MESSAGES,
    { isStreaming: true, streamingMessageId: 'assistant_seg1' }
  );

  assert.match(html, /data-reasoning-live-tail="true"/);
  assert.match(html, /status-dot--active/);
  assert.match(html, /class="reasoning-row-name">Thinking</);
  assert.doesNotMatch(html, /status-dot--ok/);
});

test('an open reasoning phase on a settled earlier segment stays settled inside a streaming turn', () => {
  // The turn is streaming, but THIS row belongs to a segment that already
  // finalized — only the live segment's tail phase may claim the live-tail
  // affordances.
  const renderer = createRowRenderer();
  const html = renderer.buildTurnRowListMarkup(
    [buildReasoningRow('row:stale', 'assistant_seg0')],
    LIVE_TURN_MESSAGES,
    { isStreaming: true, streamingMessageId: 'assistant_seg1' }
  );

  assert.doesNotMatch(html, /data-reasoning-live-tail/);
  assert.match(html, /status-dot--ok/);
  assert.match(html, /class="reasoning-row-name">Thought</);
});

test('a completed phase on the live segment renders settled even while the segment streams', () => {
  const renderer = createRowRenderer();
  const html = renderer.buildTurnRowListMarkup(
    [buildReasoningRow('row:done', 'assistant_seg1', { completed_at: '2026-08-29T22:52:53.411Z' })],
    LIVE_TURN_MESSAGES,
    { isStreaming: true, streamingMessageId: 'assistant_seg1' }
  );

  assert.doesNotMatch(html, /data-reasoning-live-tail/);
  assert.match(html, /status-dot--ok/);
});
