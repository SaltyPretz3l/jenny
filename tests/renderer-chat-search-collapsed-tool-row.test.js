'use strict';

// CTR-5 (owner gate 2026-10-02): a search match inside a collapsed, lazily
// materialized minimal tool row. Real row markup, the real keyed morph (with
// its component-preservation registry) as renderAll, and the real transcript
// click bindings, so the row opens the way a reader's click opens it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { createChatSearchOverlay } = require('../renderer/chat/renderer-chat-search-overlay');
const { createSearchBar } = require('../renderer/inventory/search-bar');
const { createSearchHighlightController } = require('../renderer/chat/renderer-chat-search-highlight');
const { createTranscriptEventBindings } = require('../renderer/chat/renderer-chat-event-transcript-bindings');
const { setChildrenHtmlPreservingKeyedNodes } = require('../renderer/chat/renderer-stream-dom-patch-utils');
const toolRowUtils = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const { waitForUiState } = require('./helpers/wait-for-ui-state');

const CODE = 'import time\nfor i in range(90):\n    print(i, flush=True)\n    time.sleep(1)';
const MESSAGES = [
  { id: 'u1', role: 'user', content: 'Run this: print(i, flush=True)' },
  { id: 'a-seg0', role: 'assistant', content: '' },
  {
    id: 'tool-use-1', role: 'assistant', kind: 'tool_use', content: 'python_execute',
    tool_call: { call_id: 'call-1', tool_name: 'python_execute', summary: 'python_execute', input_json: JSON.stringify({ code: CODE }) },
  },
];

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// `articleMessageId`: the id the turn article is anchored at. The search
// document is owned by the turn's first assistant message (a-seg0); the
// renderer's coalesced article can instead anchor at the tool_use message,
// leaving a-seg0 only a compat-anchor span (the live gate chat's shape).
function buildTimelineHtml(renderer, articleMessageId, extraRowsHtml) {
  const rowMarkup = renderer.buildToolCallRowMarkup({
    turn_id: 'turn-1', row_id: 'row-tool', primary_message_id: 'tool-use-1',
    payload: { tool_call_id: 'call-1', tool_name: 'python_execute', state: 'completed', input: { code: CODE } },
  }, MESSAGES, { sessionId: 's1', transcriptView: 'thinking' });
  const compatAnchor = articleMessageId === 'a-seg0'
    ? '' : '<span class="thread-compat-anchor" data-message-id="a-seg0" data-thread-compat-anchor="true" aria-hidden="true"></span>';
  return '<article class="chat-entry" data-message-id="u1" tabindex="-1"><div class="turn-row-list">'
    + '<div class="chat-row" data-row-id="row-user" data-row-kind="user_bubble" data-source-message-id="u1">'
    + '<div class="chat-bubble">Run this: print(i, flush=True)</div></div></div></article>'
    + compatAnchor
    + '<article class="chat-entry" data-message-id="' + articleMessageId + '" tabindex="-1"><div class="turn-row-list">'
    + '<div class="chat-row" data-row-id="row-tool" data-row-kind="tool_call" data-source-message-id="tool-use-1" data-tool-call-id="call-1">'
    + rowMarkup + '</div>' + (extraRowsHtml || '') + '</div></article>';
}

function setup(t, options = {}) {
  const articleMessageId = options.articleMessageId || 'a-seg0';
  const messages = options.messages || MESSAGES;
  toolRowUtils.clearToolRowExpansionOverrides();
  const previous = globalThis.rendererTurnRowToolRenderUtils;
  globalThis.rendererTurnRowToolRenderUtils = toolRowUtils;
  const renderer = toolRowUtils.createTurnRowToolRenderUtils({ escapeHtml, normalizeId: (value) => String(value || '').trim() });
  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="chatView"><div id="chatTimeline" role="feed"></div></div></body></html>');
  const win = dom.window;
  win.CSS = win.CSS || {};
  win.CSS.highlights = new Map();
  win.Highlight = function Highlight() { this.ranges = Array.prototype.slice.call(arguments); };
  win.HTMLElement.prototype.scrollIntoView = function () {};
  const timeline = win.document.getElementById('chatTimeline');
  // The production full render: fresh markup morphed into the live timeline,
  // the preservation registry capturing and restoring row state around it.
  const renderAll = () => setChildrenHtmlPreservingKeyedNodes(timeline, buildTimelineHtml(renderer, articleMessageId, options.extraRowsHtml));
  renderAll();
  const noOp = async () => {};
  const bindings = createTranscriptEventBindings({
    chatTimeline: timeline, state: {}, renderAll,
    handleBranchMessage: noOp, handleCopyMessage: noOp, handleRegenerateMessage: noOp,
    handleElaborateMessage: noOp, handleFollowUpMessage: noOp, handleErrorRecoveryAction: noOp,
    handleArtifactAction: noOp, toggleInteractiveRoundRecap: noOp, toggleThreadBranch: noOp,
    setReasoningPhaseExpandedPreference: noOp, syncThinkingBlockNode: noOp, resolveToolCallId: () => '',
    toggleToolDetails: noOp, thinkingController: {},
  });
  bindings.bindTranscriptEvents((target, eventName, handler, options) => target.addEventListener(eventName, handler, options));
  const reveals = [];
  const overlay = createChatSearchOverlay({
    document: win.document,
    window: win,
    chatTimeline: timeline,
    chatView: win.document.getElementById('chatView'),
    keyboardController: { focusEntryAtIndex() { return true; }, syncTabindex() {} },
    searchBarFactory: createSearchBar,
    highlightFactory: createSearchHighlightController,
    viewportReveal: { revealElement(element, options) { reveals.push({ element, range: options && options.range }); } },
    getCurrentSessionMessages: () => messages,
    getSessionTurnEventState: () => ({ turnEvents: [] }),
    renderAll,
  });
  overlay.attach();
  t.after(() => {
    overlay.dispose();
    toolRowUtils.clearToolRowExpansionOverrides();
    if (previous === undefined) delete globalThis.rendererTurnRowToolRenderUtils;
    else globalThis.rendererTurnRowToolRenderUtils = previous;
    win.close();
  });
  return { win, timeline, overlay, reveals };
}

async function assertStepOpensRowAndPaints(t, setupOptions) {
  const { win, timeline, overlay, reveals } = setup(t, setupOptions);
  const toolRow = () => timeline.querySelector('.tool-call-row--minimal');
  assert.equal(toolRow().getAttribute('data-expanded'), 'false', 'fixture: the row starts collapsed');
  assert.equal(toolRow().getAttribute('data-tool-details-materialized'), 'false', 'fixture: its details start lazy');

  overlay.open();
  const input = win.document.querySelector('.chat-search-bar-input');
  input.value = 'flush=True';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  const count = win.document.querySelector('.chat-search-bar-count');
  await waitForUiState(win, () => /1\D+2/.test(count.textContent), { message: 'expected "1 of 2"' });

  win.document.querySelector('.chat-search-bar-next').click();
  await waitForUiState(win, () => /2\D+2/.test(count.textContent), { message: 'expected "2 of 2"' });

  const row = toolRow();
  assert.equal(row.getAttribute('data-expanded'), 'true', 'the row holding the current match is open');
  assert.equal(row.getAttribute('data-tool-details-materialized'), 'true', 'its details are materialized');
  assert.equal(row.querySelector('[data-tool-row-toggle]').getAttribute('aria-expanded'), 'true');
  const body = row.querySelector('.tool-call-row-body');
  assert.equal(body.hasAttribute('inert'), false, 'the body is no longer inert');
  const current = win.CSS.highlights.get('chat-search-current');
  assert.ok(current && current.ranges[0], 'a current-match highlight is registered');
  assert.ok(body.contains(current.ranges[0].startContainer), 'the current highlight sits inside the opened body');
  assert.equal(current.ranges[0].toString(), 'flush=True');
  const lastReveal = reveals[reveals.length - 1];
  assert.equal(lastReveal.range, current.ranges[0], 'the reveal scrolls to the painted match');

  // Moving back to the first match collapses the row the search opened.
  win.document.querySelector('.chat-search-bar-prev').click();
  await waitForUiState(win, () => /1\D+2/.test(count.textContent));
  assert.equal(toolRow().getAttribute('data-expanded'), 'false', 'the transient expansion is undone when the match moves on');
  assert.equal(toolRowUtils.getToolRowExpansion(toolRow().getAttribute('data-tool-row-key')), false);
}

test('CTR-5: stepping to a match inside a collapsed tool row opens the row, paints the current match and reveals it', async (t) => {
  await assertStepOpensRowAndPaints(t, {});
});

test('CTR-5: the same holds when the turn article is anchored at the tool_use message, not the search document owner', async (t) => {
  // The live gate chat: a blank opening segment (a-seg0) owns the document
  // but renders only as a compat anchor; the article is tool-use-1's.
  await assertStepOpensRowAndPaints(t, { articleMessageId: 'tool-use-1' });
});

test('CTR-5: a prose match of a later segment binds inside an article anchored at another message', async (t) => {
  const messages = MESSAGES.concat([{ id: 'a-seg1', role: 'assistant', content: 'It printed with quokkabeam each second.' }]);
  const { win, overlay } = setup(t, {
    articleMessageId: 'tool-use-1',
    messages,
    extraRowsHtml: '<div class="chat-row" data-row-id="row-answer" data-row-kind="assistant_text" data-source-message-id="a-seg1">'
      + '<div class="chat-bubble-markdown"><p>It printed with quokkabeam each second.</p></div></div>',
  });
  overlay.open();
  const input = win.document.querySelector('.chat-search-bar-input');
  input.value = 'quokkabeam';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  const count = win.document.querySelector('.chat-search-bar-count');
  await waitForUiState(win, () => /1\D+1/.test(count.textContent), { message: 'expected "1 of 1"' });
  const current = win.CSS.highlights.get('chat-search-current');
  assert.ok(current && current.ranges[0], 'a current-match highlight is registered');
  assert.equal(current.ranges[0].toString(), 'quokkabeam');
  assert.equal(current.ranges[0].startContainer.parentElement.closest('.chat-entry').getAttribute('data-message-id'), 'tool-use-1');
});

test('CTR-5: closing the search collapses a row it opened', async (t) => {
  const { win, timeline, overlay } = setup(t);
  overlay.open();
  const input = win.document.querySelector('.chat-search-bar-input');
  input.value = 'flush=True';
  input.dispatchEvent(new win.Event('input', { bubbles: true }));
  const count = win.document.querySelector('.chat-search-bar-count');
  await waitForUiState(win, () => /1\D+2/.test(count.textContent));
  win.document.querySelector('.chat-search-bar-next').click();
  await waitForUiState(win, () => timeline.querySelector('.tool-call-row--minimal').getAttribute('data-expanded') === 'true',
    { message: 'the search opens the row' });
  overlay.close();
  assert.equal(timeline.querySelector('.tool-call-row--minimal').getAttribute('data-expanded'), 'false');
});
