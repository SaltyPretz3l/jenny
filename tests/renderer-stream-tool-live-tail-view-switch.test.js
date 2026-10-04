'use strict';

// TTL-1: a still-running tool row keeps its live output pane across
// transcript view switches (Thinking -> Everything -> Answers -> Thinking),
// rehydrated from the retained tail, and keeps streaming into it. Uses the
// production row builder, keyed morph and minimal-row toggle.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const toolCallUtils = require('../renderer/chat/tool-call-utils');
const toolRowUtils = require('../renderer/chat/renderer-turn-row-tool-render-utils');
const patch = require('../renderer/chat/renderer-stream-dom-patch-utils');
const { createTranscriptEventBindings } = require('../renderer/chat/renderer-chat-event-transcript-bindings');
const { createToolLiveTail } = require('../renderer/chat/renderer-stream-tool-live-tail');
const { escapeHtml } = require('../renderer/shared/string-utils');

const SESSION = 's1';
const ROW_KEY = toolCallUtils.buildToolRowKey({ sessionId: SESSION, turnId: 't1', rowId: 'r1', callId: 'call_0' });

function runningRow(state = 'running') {
  return {
    turn_id: 't1',
    row_id: 'r1',
    payload: {
      tool_call_id: 'call_0', tool_name: 'run_command', state, running_started_at_ms: 1000,
      input: { command: 'ping -n 25 127.0.0.1', timeout_seconds: 600 },
    },
  };
}

function setup(t) {
  const previousToolCallUtils = globalThis.toolCallUtils;
  const previousRowUtils = globalThis.rendererTurnRowToolRenderUtils;
  globalThis.toolCallUtils = toolCallUtils;
  globalThis.rendererTurnRowToolRenderUtils = toolRowUtils;
  toolRowUtils.clearToolRowExpansionOverrides();
  const renderer = toolRowUtils.createTurnRowToolRenderUtils({ escapeHtml, normalizeId: (value) => String(value || '').trim() });
  const dom = new JSDOM('<div id="chatTimeline"></div>');
  const timeline = dom.window.document.getElementById('chatTimeline');
  const ctx = { view: 'thinking', state: 'running' };
  function render(view = ctx.view, state = ctx.state) {
    ctx.view = view;
    ctx.state = state;
    const rowMarkup = renderer.buildToolCallRowMarkup(runningRow(state), [], { sessionId: SESSION, transcriptView: view });
    patch.setChildrenHtmlPreservingKeyedNodes(
      timeline,
      `<div class="chat-row" data-row-id="t1:tool_call:call_0" data-tool-call-id="call_0">${rowMarkup}</div>`
    );
  }
  const noOp = async () => {};
  const bindings = createTranscriptEventBindings({
    chatTimeline: timeline, state: {}, renderAll: () => render(),
    handleBranchMessage: noOp, handleCopyMessage: noOp, handleRegenerateMessage: noOp,
    handleElaborateMessage: noOp, handleFollowUpMessage: noOp, handleErrorRecoveryAction: noOp,
    handleArtifactAction: noOp, toggleInteractiveRoundRecap: noOp, toggleThreadBranch: noOp,
    setReasoningPhaseExpandedPreference: noOp, syncThinkingBlockNode: noOp, resolveToolCallId: () => '',
    toggleToolDetails: noOp, thinkingController: {},
  });
  bindings.bindTranscriptEvents((target, eventName, handler, options) => target.addEventListener(eventName, handler, options));
  const tail = createToolLiveTail({ getChatTimeline: () => timeline });
  t.after(() => {
    tail.dispose();
    toolRowUtils.clearToolRowExpansionOverrides();
    globalThis.toolCallUtils = previousToolCallUtils;
    if (previousRowUtils === undefined) delete globalThis.rendererTurnRowToolRenderUtils;
    else globalThis.rendererTurnRowToolRenderUtils = previousRowUtils;
    dom.window.close();
  });
  const helpers = {
    dom,
    timeline,
    tail,
    render,
    row: () => timeline.querySelector('.tool-call-row--minimal'),
    chunk(text) {
      return tail.appendChunk({ sessionId: SESSION, streamId: 'a', callId: 'call_0', lines: [{ text }] });
    },
    switchView(view) {
      // renderer-app-lifecycle-preferences resetSessionOverrides, then renderAll.
      toolRowUtils.clearToolRowExpansionOverridesForSession(SESSION);
      render(view);
    },
    open() {
      if (helpers.row().getAttribute('data-expanded') === 'true') return;
      timeline.querySelector('[data-tool-row-toggle]').dispatchEvent(
        new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })
      );
    },
    settle: () => new Promise((resolve) => dom.window.setTimeout(resolve, 0)),
    // The pane the user sees: a direct child of the row body with its text.
    bodyPaneText() {
      const panes = Array.from(helpers.row().querySelectorAll('.tool-call-row-body > .tool-live-output'));
      assert.equal(panes.length, 1, 'exactly one live pane, inside the row body');
      const text = panes[0].querySelector('.tool-live-output-text');
      assert.ok(text, 'the pane keeps its text node');
      return text.textContent;
    },
  };
  return helpers;
}

test('a running row re-shows its retained output after Thinking -> Everything -> Answers -> Thinking', async (t) => {
  const h = setup(t);
  h.render('thinking');
  h.chunk('Pinging 127.0.0.1');
  h.open();
  await h.settle();
  assert.equal(h.bodyPaneText(), 'Pinging 127.0.0.1');

  h.switchView('everything');
  await h.settle();
  assert.equal(h.row().getAttribute('data-expanded'), 'true');
  assert.equal(h.bodyPaneText(), 'Pinging 127.0.0.1');
  h.chunk('Reply 1');

  h.switchView('answers');
  await h.settle();
  h.open();
  await h.settle();
  assert.equal(h.bodyPaneText(), 'Pinging 127.0.0.1\nReply 1');

  h.switchView('thinking');
  await h.settle();
  h.open();
  await h.settle();
  assert.equal(h.row().getAttribute('data-expanded'), 'true');
  assert.equal(h.bodyPaneText(), 'Pinging 127.0.0.1\nReply 1', 'rehydrated without waiting for a chunk');

  assert.equal(h.chunk('Reply 2'), true);
  assert.equal(h.bodyPaneText(), 'Pinging 127.0.0.1\nReply 1\nReply 2', 'keeps streaming into the rehydrated pane');
});

test('a row re-rendered out of the live state and back in place gets its retained output without a new chunk', async (t) => {
  const h = setup(t);
  h.render('thinking');
  h.open();
  h.chunk('line one');
  await h.settle();
  assert.equal(h.bodyPaneText(), 'line one');

  // A view-switch render lands the row in a transient non-live state: the
  // morph drops the pane and the tail has no live row to repaint.
  h.render('answers', 'approved');
  await h.settle();
  assert.equal(h.row().querySelector('.tool-live-output'), null);

  // The row flips back to running in place (an attribute write, as the live
  // tool patch lane does): the retained output must come back on its own.
  h.row().setAttribute('data-tool-status', 'running');
  await h.settle();
  assert.equal(h.bodyPaneText(), 'line one');
});

test('a stranded or gutted pane is rebuilt in the row body from the retained output', async (t) => {
  const h = setup(t);
  h.render('thinking');
  h.open();
  h.chunk('kept output');
  await h.settle();

  // A pane that kept its identity but lost its text node never paints again.
  h.row().querySelector('.tool-live-output-text').remove();
  assert.equal(h.chunk('more output'), true);
  assert.equal(h.bodyPaneText(), 'kept output\nmore output');

  // A pane outside the row body (the body is what the row shows and hides).
  const pane = h.row().querySelector('.tool-live-output');
  h.row().querySelector('.tool-call-row-header').appendChild(pane);
  await h.settle();
  assert.equal(h.row().querySelectorAll('.tool-live-output').length, 1);
  assert.equal(h.bodyPaneText(), 'kept output\nmore output');
});
