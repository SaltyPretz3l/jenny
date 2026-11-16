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

test('flag ON: a streaming assistant bubble holds back a marker still arriving instead of flashing it', () => {
  const renderer = createRenderer({ getFeatureFlags: () => ({ source_citations: true }) });
  const row = citationMarkerRow('partial answer 【web:1');
  const html = renderer.buildTurnRowListMarkup(
    [row],
    [{ id: 'assistant_web', role: 'assistant', content: 'partial answer 【web:1', streamId: 'turn_web' }],
    { isStreaming: true, streamingRowId: 'turn_web:assistant_text:0', streamingMessageId: 'assistant_web' }
  );
  assert.match(html, /partial answer/);
  assert.doesNotMatch(html, /【|web:1/);
});

// Numbered references (row 154 S2): the final answer row carries the inline
// numbers and the sources list; the per-call notice rows render nothing.
function sourceNoticeRow(rowId, refs) {
  return {
    row_id: rowId,
    turn_id: 'turn_web',
    kind: 'system_notice',
    primary_message_id: `tool_${rowId}`,
    payload: { subkind: 'source_citations', refs },
  };
}

function textRow(rowId, text, extra) {
  return {
    row_id: rowId,
    turn_id: 'turn_web',
    kind: 'assistant_text',
    primary_message_id: `assistant_${rowId}`,
    payload: { text, segment_group_index: 0 },
    ...extra,
  };
}

const WEB_REFS = [
  { url: 'https://example.com/one', title: 'One', snippet: 's1', sourceType: 'web', n: 1 },
  { url: 'https://example.com/two', title: 'Two', snippet: 's2', sourceType: 'web', n: 2 },
];

function renderTurn(rows, options, flags) {
  const renderer = createRenderer({ getFeatureFlags: () => flags || { source_citations: true } });
  return renderer.buildTurnRowListMarkup(rows, [], { turnRows: rows, ...options });
}

test('numbered refs: the final answer row has sup.source-ref and one source list', () => {
  const rows = [
    sourceNoticeRow('n1', WEB_REFS),
    textRow('a1', 'Early claim [web:1].'),
    textRow('a2', 'Final claim [web:2] [web:1].'),
  ];
  const html = renderTurn(rows);
  assert.equal((html.match(/<section class="source-list"/g) || []).length, 1);
  assert.ok(html.indexOf('<section class="source-list"') > html.indexOf('Final claim'), 'list sits after the final answer bubble');
  assert.match(html, /Early claim<sup class="source-ref"><a class="source-ref-link"[^>]*data-source-ref="1"/);
  assert.match(html, /Final claim<sup class="source-ref"><a [^>]*data-source-ref="2"[^>]*>2<\/a>,<a [^>]*data-source-ref="1"/);
  assert.doesNotMatch(html, /\[web:|【web:/);
  assert.doesNotMatch(html, /citation-chip/);
});

test('numbered refs: an earlier assistant_text row has numbers and no list', () => {
  const rows = [
    sourceNoticeRow('n1', WEB_REFS),
    textRow('a1', 'Early claim [web:1].'),
    textRow('a2', 'Final answer without markers.'),
  ];
  const renderer = createRenderer({ getFeatureFlags: () => ({ source_citations: true }) });
  const early = renderer.buildTurnRowListMarkup([rows[1]], [], { turnRows: rows });
  assert.match(early, /<sup class="source-ref">/);
  assert.doesNotMatch(early, /source-list/);
  const final = renderer.buildTurnRowListMarkup([rows[2]], [], { turnRows: rows });
  assert.match(final, /<section class="source-list"/);
  assert.doesNotMatch(final, /source-ref"/);
});

test('numbered refs: a streaming row has neither numbers nor list', () => {
  const rows = [sourceNoticeRow('n1', WEB_REFS), textRow('a1', 'Streaming claim [web:1] and [web:2')];
  const html = createRenderer({ getFeatureFlags: () => ({ source_citations: true }) }).buildTurnRowListMarkup(
    [rows[1]],
    [{ id: 'assistant_a1', role: 'assistant', content: rows[1].payload.text, streamId: 'turn_web' }],
    { turnRows: rows, isStreaming: true, streamingRowId: 'turn_web:assistant_text:a1', streamingMessageId: 'assistant_a1', isStreamingRow: () => true }
  );
  assert.match(html, /Streaming claim/);
  assert.doesNotMatch(html, /source-ref|source-list|\[web:/);
});

test('numbered refs: flag off renders the raw markers and no list', () => {
  const rows = [sourceNoticeRow('n1', WEB_REFS), textRow('a1', 'Claim [web:1].')];
  const html = renderTurn(rows, null, { source_citations: false });
  assert.match(html, /Claim \[web:1\]\./);
  assert.doesNotMatch(html, /source-ref|source-list/);
});

test('numbered refs: a source_citations notice row renders nothing when a final answer exists', () => {
  const rows = [sourceNoticeRow('n1', WEB_REFS), textRow('a1', 'Claim [web:1].')];
  const renderer = createRenderer({ getFeatureFlags: () => ({ source_citations: true }) });
  assert.doesNotMatch(renderer.buildTurnRowListMarkup([rows[0]], [], { turnRows: rows }), /chat-row|source-list/);
});

test('numbered refs: a turn with notices and no assistant text renders the unnumbered list once, on the last notice', () => {
  const rows = [
    sourceNoticeRow('n1', WEB_REFS.slice(0, 1)),
    sourceNoticeRow('n2', [WEB_REFS[0], { url: 'https://example.com/three', title: 'Three', n: 2 }]),
  ];
  const renderer = createRenderer({ getFeatureFlags: () => ({ source_citations: true }) });
  assert.doesNotMatch(renderer.buildTurnRowListMarkup([rows[0]], [], { turnRows: rows }), /chat-row|source-list/);
  const last = renderer.buildTurnRowListMarkup([rows[1]], [], { turnRows: rows });
  assert.equal((last.match(/<section class="source-list"/g) || []).length, 1);
  assert.match(last, /source-list--plain/);
  assert.equal((last.match(/class="source-list-item"/g) || []).length, 2, 'deduped across the two calls');
  assert.equal(renderTurn(rows).split('<section class="source-list"').length - 1, 1, 'whole turn renders the list exactly once');
  assert.doesNotMatch(renderTurn(rows, null, { source_citations: false }), /chat-row|source-list/);
});

test('numbered refs: no sources list while the turn is still active, so it never shows under an earlier segment and moves', () => {
  const rows = [sourceNoticeRow('n1', WEB_REFS), textRow('a1', 'Settled segment [web:1].')];
  const active = { streamingMessageId: 'assistant_next', streamingRowId: '', isStreamingRow: () => false };
  const html = renderTurn(rows, active);
  assert.match(html, /Settled segment<sup class="source-ref">/, 'a settled segment still gets its numbers');
  assert.doesNotMatch(html, /source-list/);
  const toolsOnly = [sourceNoticeRow('n1', WEB_REFS)];
  assert.doesNotMatch(renderTurn(toolsOnly, active), /source-list/, 'no fallback list mid-turn either');
  assert.match(renderTurn(rows), /<section class="source-list"/, 'the list appears once the turn settles');
  // Between a tool result and the next text the turn is live with no streaming ids (review 2026-11-14).
  assert.doesNotMatch(renderTurn(rows, { turnLive: true }), /source-list/);
  assert.doesNotMatch(renderTurn(toolsOnly, { turnLive: true }), /source-list/);
});
