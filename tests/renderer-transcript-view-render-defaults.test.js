// Transcript views (answers | thinking | everything): the render side.
// The view reaches the shared row builders through render options and
// changes only expansion DEFAULTS (per-row overrides still win) plus, for
// 'answers', the live-turn marker the stylesheet keys on. The row set never
// changes (tests/timeline-replay-corpus-render.test.js P5 pins that).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { shouldAutoExpandReasoningV2 } = require('../renderer/chat/reasoning-row-v2-utils');
const toolCallUtils = require('../renderer/chat/tool-call-utils');
const { createTurnRowListUtils } = require('../renderer/chat/renderer-turn-row-list-utils');
const {
  createTurnRowToolRenderUtils,
  setToolRowExpansion,
  getToolRowExpansion,
  clearToolRowExpansionOverrides,
  clearToolRowExpansionOverridesForSession,
} = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const {
  createTranscriptToolCallRenderer,
  clearToolCallExpansionOverridesForSession,
} = require('../renderer/chat/renderer-transcript-tool-calls');
const {
  clearReasoningStreamStateCache,
  createReasoningV2Renderer,
} = require('../renderer/chat/renderer-transcript-reasoning-v2');
const {
  ThinkingPanelController,
  groupReasoningByPhase,
  shouldShowThinkingToggle,
} = require('../renderer/chat/chat-thinking-utils');
const { escapeHtml } = require('../renderer/shared/string-utils');

test.beforeEach(() => {
  clearReasoningStreamStateCache();
  clearToolRowExpansionOverrides();
});

/* ── pure default rules ── */

test('reasoning default: answers never opens, everything always opens, thinking keeps the streaming rule', () => {
  for (const status of ['streaming', 'complete', 'error', 'empty']) {
    assert.equal(shouldAutoExpandReasoningV2(status, { isStreaming: true, transcriptView: 'answers' }), false, `answers ${status} live`);
    assert.equal(shouldAutoExpandReasoningV2(status, { isStreaming: false, transcriptView: 'answers' }), false, `answers ${status}`);
    assert.equal(shouldAutoExpandReasoningV2(status, { isStreaming: false, transcriptView: 'everything' }), true, `everything ${status}`);
  }
  assert.equal(shouldAutoExpandReasoningV2('complete', { isStreaming: false, transcriptView: 'thinking' }), false);
  assert.equal(shouldAutoExpandReasoningV2('streaming', { isStreaming: false, transcriptView: 'thinking' }), true);
  assert.equal(shouldAutoExpandReasoningV2('complete', { isStreaming: true, transcriptView: 'thinking' }), true);
  // A missing view is today's behaviour.
  assert.equal(shouldAutoExpandReasoningV2('complete', { isStreaming: false }), false);
  assert.equal(shouldAutoExpandReasoningV2('complete', { isStreaming: true }), true);
});

test('tool default: everything opens every status; answers and thinking keep the approval-only rule', () => {
  for (const status of ['completed', 'running', 'errored', 'awaiting_approval']) {
    assert.equal(toolCallUtils.shouldAutoExpandToolDetails(status, { transcriptView: 'everything' }), true, `everything ${status}`);
  }
  for (const view of ['answers', 'thinking', undefined]) {
    assert.equal(toolCallUtils.shouldAutoExpandToolDetails('completed', { transcriptView: view }), false, `${view} completed`);
    assert.equal(toolCallUtils.shouldAutoExpandToolDetails('errored', { transcriptView: view }), false, `${view} errored`);
    assert.equal(toolCallUtils.shouldAutoExpandToolDetails('awaiting_approval', { transcriptView: view }), true, `${view} approval`);
  }
  assert.equal(toolCallUtils.shouldAutoExpandToolDetails('completed'), false, 'no options object');
});

/* ── row list: the live-turn marker the answers stylesheet keys on ── */

// The marker follows the turn-level live signal (projection-context liveTurnId),
// never the turn phase: a preamble or a tool result reads 'done' mid-turn.
test('the row list stamps data-turn-live only for turnLive, whatever the turn phase', () => {
  const rowList = createTurnRowListUtils({ buildRowBodyMarkup: () => '<div>row</div>' });
  const rows = [{ row_id: 'row:1', turn_id: 't1', kind: 'assistant_text', payload: { text: 'hi' } }];
  for (const phase of ['done', 'thinking', 'running_tool', '']) {
    assert.match(rowList.buildTurnRowListMarkup(rows, [], { turnPhase: phase, turnLive: true }), /data-turn-live="true"/, phase || '(none)');
    assert.doesNotMatch(rowList.buildTurnRowListMarkup(rows, [], { turnPhase: phase }), /data-turn-live/, phase || '(none)');
  }
});

/* ── minimal tool rows (row model) ── */

function createToolRenderer() {
  return createTurnRowToolRenderUtils({
    escapeHtml,
    normalizeId: (value) => String(value || '').trim(),
    formatDurationMs: () => '',
    renderArtifactTeaser: () => '',
    buildToolMarkerBannerMarkup: () => '',
    renderApprovalBlock: () => '',
  });
}

function toolRow(callId, state = 'completed') {
  return {
    turn_id: 'turn-1',
    row_id: `row-${callId}`,
    payload: { tool_call_id: callId, tool_name: 'read_file', state, input: { path: 'README.md' } },
  };
}

test('minimal tool row: everything materializes the details by default; answers and thinking collapse', () => {
  const renderer = createToolRenderer();
  const everything = renderer.buildToolCallRowMarkup(toolRow('call-e'), [], { sessionId: 's1', transcriptView: 'everything' });
  assert.match(everything, /data-expanded="true"/);
  assert.match(everything, /class="tool-call-row-body"/);
  for (const view of ['answers', 'thinking']) {
    const html = renderer.buildToolCallRowMarkup(toolRow('call-c'), [], { sessionId: 's1', transcriptView: view });
    assert.match(html, /data-expanded="false"/, view);
  }
  // An approval row stays open in answers: the user still has to act on it.
  assert.match(
    renderer.buildToolCallRowMarkup(toolRow('call-a', 'awaiting_approval'), [], { sessionId: 's1', transcriptView: 'answers' }),
    /data-expanded="true"/
  );
});

test('minimal tool row: a user override beats the view default until the session is cleared', () => {
  const renderer = createToolRenderer();
  const row = toolRow('call-o');
  const rowKey = toolCallUtils.buildToolRowKey({ sessionId: 's1', turnId: row.turn_id, rowId: row.row_id, callId: 'call-o' });
  setToolRowExpansion(rowKey, false);
  assert.match(renderer.buildToolCallRowMarkup(row, [], { sessionId: 's1', transcriptView: 'everything' }), /data-expanded="false"/);

  const otherKey = toolCallUtils.buildToolRowKey({ sessionId: 's2', turnId: 'turn-9', rowId: 'row-9', callId: 'call-9' });
  setToolRowExpansion(otherKey, true);
  clearToolRowExpansionOverridesForSession('s1');
  assert.equal(getToolRowExpansion(rowKey), undefined, 'the switched session forgets its override');
  assert.equal(getToolRowExpansion(otherKey), true, 'another session keeps its override');
  assert.match(renderer.buildToolCallRowMarkup(row, [], { sessionId: 's1', transcriptView: 'everything' }), /data-expanded="true"/);
  clearToolRowExpansionOverridesForSession('');
  assert.equal(getToolRowExpansion(otherKey), true, 'a blank session id clears nothing');
});

/* ── classic tool blocks (legacy article family) ── */

function toolMessages(callId) {
  const toolUse = {
    id: `tool_use_${callId}`,
    role: 'assistant',
    kind: 'tool_use',
    tool_call: { call_id: callId, tool_name: 'read_file', input: { path: 'README.md' }, status: 'completed' },
  };
  const toolResult = {
    id: `tool_result_${callId}`,
    role: 'tool',
    kind: 'tool_result',
    tool_result: { call_id: callId, tool_name: 'read_file', output_text: 'hello', is_error: false },
  };
  return { toolUse, messages: [toolUse, toolResult] };
}

test('classic tool block: the view default flows through the view model and the per-session clear', () => {
  const renderer = createTranscriptToolCallRenderer({ escapeHtml, toolCallUtils });
  const { toolUse, messages } = toolMessages('call-classic');
  const collapsed = renderer.buildToolCallViewModel(toolUse, messages, { sessionId: 's1', transcriptView: 'thinking' });
  const opened = renderer.buildToolCallViewModel(toolUse, messages, { sessionId: 's1', transcriptView: 'everything' });
  assert.equal(collapsed.defaultExpanded, false);
  assert.equal(opened.defaultExpanded, true);
  assert.equal(opened.expandFileDiffsByDefault, false, 'nested diffs stay closed unless the user opened the row');

  renderer.setToolCallExpansion(opened.rowKey, false);
  assert.equal(renderer.buildToolCallViewModel(toolUse, messages, { sessionId: 's1', transcriptView: 'everything' }).defaultExpanded, false);
  clearToolCallExpansionOverridesForSession('s2');
  assert.equal(renderer.getToolCallExpansion(opened.rowKey), false, 'clearing another session keeps the override');
  clearToolCallExpansionOverridesForSession('s1');
  assert.equal(renderer.getToolCallExpansion(opened.rowKey), undefined);
  assert.equal(renderer.buildToolCallViewModel(toolUse, messages, { sessionId: 's1', transcriptView: 'everything' }).defaultExpanded, true);
});

/* ── reasoning rows ── */

function makeReasoningRenderer() {
  return createReasoningV2Renderer({
    escapeHtml,
    groupReasoningByPhase,
    getReasoningEntries: (message) => (message?.reasoning?.entries || []),
    renderMarkdown: (s) => `<p>${escapeHtml(s)}</p>`,
    renderStreamingMarkdownUnits: (s) => ({ html: `<p>${escapeHtml(s)}</p>` }),
    shouldShowThinkingToggle,
    thinkingController: new ThinkingPanelController(),
  });
}

function settledReasoningMessage(id) {
  return {
    id,
    role: 'assistant',
    status: 'complete',
    reasoning: { source: 'provider', status: 'complete', entries: [{ id: `${id}-r1`, text: 'Weighing the options carefully.' }] },
  };
}

test('reasoning row: everything opens a settled phase; answers and thinking leave it collapsed', () => {
  const renderer = makeReasoningRenderer();
  const opened = renderer.renderThinkingWidget(settledReasoningMessage('a-open'), '', { transcriptView: 'everything' });
  assert.match(opened, /data-default-expanded="true"/);
  assert.match(opened, /class="reasoning-row-panel expanded"/);
  for (const view of ['answers', 'thinking']) {
    const html = renderer.renderThinkingWidget(settledReasoningMessage(`a-${view}`), '', { transcriptView: view });
    assert.match(html, /data-default-expanded="false"/, view);
    assert.doesNotMatch(html, /class="reasoning-row-panel expanded"/, view);
  }
  // No options at all is the thinking rule (today's markup).
  assert.match(renderer.renderThinkingWidget(settledReasoningMessage('a-none'), ''), /data-default-expanded="false"/);
});

test('reasoning row: answers keeps a streaming phase collapsed (header-only progress line)', () => {
  const renderer = makeReasoningRenderer();
  const message = {
    id: 'a-live',
    role: 'assistant',
    status: 'streaming',
    reasoning: { source: 'provider', status: 'streaming', entries: [{ id: 'a-live-r1', text: 'Still thinking about it.' }] },
  };
  const answers = renderer.renderThinkingWidget(message, 'a-live', { transcriptView: 'answers' });
  assert.match(answers, /data-reasoning-live-tail="true"/);
  assert.match(answers, /data-default-expanded="false"/);
  // po-review C1: the header line is not clickable (no toggle, no focus stop, no override write).
  assert.match(answers, /data-default-expanded="false" disabled\s/, 'the answers header renders disabled');
  // TV-6: no toggle semantics on the plain line; its visible text is the name.
  const answersHeader = /<button[^>]*class="reasoning-row-header"[^>]*>/.exec(answers)[0];
  for (const attr of ['aria-label', 'aria-expanded', 'aria-controls']) {
    assert.doesNotMatch(answersHeader, new RegExp(`\\s${attr}=`), `the answers header carries no ${attr}`);
  }
  assert.match(answersHeader, /\sid="[^"]+-toggle"/, 'the header keeps the id the panel is labelled by');
  assert.match(answersHeader, /data-reasoning-toggle="true"/);
  const thinking = renderer.renderThinkingWidget(message, 'a-live', { transcriptView: 'thinking' });
  assert.match(thinking, /data-default-expanded="true"/);
  assert.doesNotMatch(thinking, /<button[^>]*\sdisabled/, 'thinking keeps the toggle');
  const thinkingHeader = /<button[^>]*class="reasoning-row-header"[^>]*>/.exec(thinking)[0];
  for (const attr of ['aria-label', 'aria-expanded', 'aria-controls']) {
    assert.match(thinkingHeader, new RegExp(`\\s${attr}="[^"]+"`), `the thinking toggle keeps ${attr}`);
  }
});

test('reasoning row: everything leaves a settled body-less phase collapsed (no caret over an empty panel)', () => {
  const renderer = makeReasoningRenderer();
  const bodyless = {
    id: 'a-empty',
    role: 'assistant',
    status: 'complete',
    reasoning: { source: 'provider', status: 'complete', entries: [{ id: 'a-empty-r1', text: '   ' }] },
  };
  const html = renderer.renderThinkingWidget(bodyless, '', { transcriptView: 'everything' });
  assert.match(html, /class="reasoning-row-block"/, 'the block carries no expanded class');
  assert.match(html, /data-default-expanded="false"/, 'the toggle default matches what is shown');
  assert.match(html, /class="reasoning-row-panel empty"/);
  // A phase with a body still opens by default in everything.
  assert.match(
    renderer.renderThinkingWidget(settledReasoningMessage('a-body'), '', { transcriptView: 'everything' }),
    /class="reasoning-row-block expanded"/
  );
});

/* ── the answers stylesheet rules ── */

test('chat-thread-rail.css hides settled reasoning rows in answers and keeps the live turn header-only', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'styles', 'chat-thread-rail.css'), 'utf8');
  const compact = css.replace(/\s+/g, ' ');
  assert.match(
    compact,
    /\.chat-timeline\[data-transcript-view="answers"\] \.turn-row-list:not\(\[data-turn-live="true"\]\) \.chat-row\[data-row-kind="reasoning"\] \{ display: none; \}/,
    'settled reasoning rows hide'
  );
  assert.match(
    compact,
    /\.chat-timeline\[data-transcript-view="answers"\] \.turn-row-list\[data-turn-live="true"\] \.reasoning-row-panel, \.chat-timeline\[data-transcript-view="answers"\] \.turn-row-list\[data-turn-live="true"\] \.reasoning-row-caret \{ display: none; \}/,
    'the live turn keeps the header and drops panel + caret'
  );
  // The legacy-path rules are matched against real markup in
  // tests/renderer-transcript-view-styles.test.js.
  assert.match(
    compact,
    /\.chat-timeline\[data-transcript-view="answers"\] \.reasoning-row-header:disabled \{ cursor: default; background: transparent; color: var\(--text-secondary\); \}/,
    'the disabled live header is a plain line'
  );
  assert.doesNotMatch(compact, /data-transcript-view="thinking"|data-transcript-view="everything"/, 'the other views need no rules');
});
