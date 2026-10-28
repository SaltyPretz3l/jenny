'use strict';

// Count pins from the 2026-10-25 composer keystroke / send render-churn pass.
// Each composer render runs on every keystroke, so work it does while idle is
// paid per character typed. (The keystroke handler pin lives in
// tests/renderer-chat-event-utils-pane-bindings.test.js.)

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');

const { syncAdmissionWaitLine } = require('../renderer/chat/renderer-admission-wait-line');
const { createInteractivePanelRenderer } = require('../renderer/features/renderer-interactive-panel-utils');
const { buildMessageSequence, createControllerHarness } = require('./helpers/send-controller-harness');

function countingTimeline() {
  const counts = { query: 0 };
  return {
    counts,
    timeline: {
      querySelector() { counts.query += 1; return null; },
      querySelectorAll() { counts.query += 1; return []; },
    },
  };
}

test('an idle composer render does not search the timeline for an admission wait line', () => {
  const { counts, timeline } = countingTimeline();

  syncAdmissionWaitLine({ timeline, state: {}, rows: [] });
  syncAdmissionWaitLine({ timeline, state: {}, rows: [{ wait: { reason: 'grace' } }] });

  assert.equal(counts.query, 0);
});

test('the admission wait line still mounts, and goes once nothing is held', (t) => {
  const { window } = new JSDOM('<!doctype html><div id="timeline"><article></article></div>');
  t.after(() => window.close());
  const timeline = window.document.getElementById('timeline');
  const held = [{ wait: { reason: 'model_busy', blockingSessionId: 'session-2' } }];

  const node = syncAdmissionWaitLine({ timeline, state: { sessions: [] }, rows: held });
  assert.equal(timeline.lastElementChild, node);
  assert.equal(syncAdmissionWaitLine({ timeline, state: { sessions: [] }, rows: held }), node, 'unchanged words keep the node');

  syncAdmissionWaitLine({ timeline, state: { sessions: [] }, rows: [] });
  assert.equal(timeline.querySelector('[data-admission-wait-line]'), null);
});

test('an idle interactive panel render does not look up the inline mount', () => {
  const { counts, timeline } = countingTimeline();
  const renderer = createInteractivePanelRenderer({
    state: { ui: {}, backend: { phase: 'ready' }, auth: { authenticated: true } },
    dom: { composer: null, chatInput: null, chatTimeline: timeline },
    callbacks: {
      getPendingQuestionBatch: () => null,
      hasStalePendingQuestionBatch: () => false,
      getInteractiveDraft: () => ({}),
      isSendBusy: () => false,
      escapeHtml: (value) => String(value),
    },
  });

  renderer.renderComposerInteractivePanel();

  assert.equal(counts.query, 0);
});

test('an accepted send renders the composer once after it settles, not again before', async (t) => {
  const harness = createControllerHarness(buildMessageSequence(), { chatInputValue: 'hello' });
  t.after(() => harness.restore());

  const result = await harness.controller.startPromptSend('hello', { sessionIdOverride: 'session-1' });

  assert.equal(result?.streamId, 'stream-regen');
  assert.equal(harness.calls.renderComposerState, 2, 'one at send start, one in finalizeSend');
});
